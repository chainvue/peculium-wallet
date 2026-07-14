/**
 * Policy schema — two layers in one zod pipeline:
 *
 * - the INPUT side (`z.input<typeof policyFileSchema>`) is the JSON-safe
 *   `policy.json` shape: amounts are exact decimal strings, nothing a JSON
 *   round-trip could corrupt;
 * - the OUTPUT side is the runtime `Policy`: every amount is bigint
 *   satoshis, parsed by verus-rpc `parseAmount` so no float ever exists.
 *
 * All objects are strict: an unknown key is a parse error, because a typo
 * like `maxPerTX` silently ignored would mean a cap silently not applied.
 *
 * File IO does NOT live here — `parsePolicy` takes already-decoded JSON.
 * The later load.ts owns reading, permission checks and reload-on-change.
 */

import { formatAmount, parseAmount } from "verus-rpc";
import { z } from "zod";

import { PolicyLimitError, PolicyParseError } from "../errors.js";
import {
  hardCapsFor,
  isNativeCurrency,
  nativeCurrencyOf,
  paidFetchHardCapsFor,
  SUPPORTED_CHAINS,
  type AddressMode,
  type SupportedChain,
} from "../limits.js";

/** Per-currency spending caps, in satoshis (trailing-24h "day"). */
export interface CurrencyPolicy {
  currency: string;
  maxPerTxSats: bigint;
  maxPerDaySats: bigint;
  maxTotalSats: bigint;
}

/** An allowlisted v402 facilitator with its own auto-approve budget. */
export interface FacilitatorPolicy {
  name: string;
  address: string;
  currency: string;
  maxPerTxSats: bigint;
  maxPerDaySats: bigint;
  autoApprove: boolean;
  /**
   * The facilitator's HTTP base URL (its v402 API), when the operator
   * recorded one — enables signed prepaid-balance queries, and since
   * paid-fetch it is also the trust anchor a 402 offer's `facilitator`
   * field must match before any payment is signed (offer-facilitator
   * pinning). On-chain money movement never depends on it.
   */
  apiUrl?: string;
}

/** An allowlisted send recipient (sends always require confirmation). */
export interface RecipientPolicy {
  name: string;
  address: string;
}

/**
 * An allowlisted PAID SERVICE for `wallet_paid_fetch` — a v402-guarded API
 * the agent may pay per request with PREPAID credit. The agent names the
 * service; the wallet builds the URL from `origin`, so a prompt-injected
 * URL has nowhere to go (the same names-not-addresses boundary the rest of
 * the wallet enforces). `facilitator` names the allowlisted bank whose
 * prepaid pool funds this service — the 402 offer must clear through
 * exactly that facilitator's API. Caps bound the RATE of burning prepaid
 * credit; they are not wallet-fund caps (those applied at topup time).
 */
export interface ServicePolicy {
  name: string;
  /** Normalized http(s) origin, e.g. "https://api.example.com" — no path. */
  origin: string;
  /** Allowlisted facilitator NAME whose prepaid balance funds this service. */
  facilitator: string;
  currency: string;
  maxPricePerCallSats: bigint;
  maxPerDaySats: bigint;
  autoApprove: boolean;
}

/** Wallet-wide rate limits (counted across all currencies). */
export interface RatePolicy {
  maxSendsPerHour: number;
  minSecondsBetweenSends: number;
  dedupeWindowSeconds: number;
}

/** The runtime policy: validated, satoshi-denominated, hard-cap checked. */
export interface Policy {
  schemaVersion: 1;
  network: SupportedChain;
  agentAddress: string;
  addressMode: AddressMode;
  currencies: CurrencyPolicy[];
  facilitators: FacilitatorPolicy[];
  recipients: RecipientPolicy[];
  services: ServicePolicy[];
  rate: RatePolicy;
  armRequired: boolean;
  confirmTimeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A cap amount: exact decimal string in the file, bigint sats at runtime.
 * Caps must be strictly positive — "make this currency unspendable" is
 * expressed by removing its entry, not by a zero cap.
 */
const capSatsSchema = z.string().transform((value, ctx): bigint => {
  let sats: bigint;
  try {
    sats = parseAmount(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "not a decimal amount",
    });
    return z.NEVER;
  }
  if (sats <= 0n) {
    ctx.addIssue({ code: "custom", message: `cap must be positive: ${value}` });
    return z.NEVER;
  }
  return sats;
});

const isoDateTimeSchema = z.iso.datetime({ offset: true });

const currencyEntrySchema = z
  .strictObject({
    currency: z.string().min(1),
    maxPerTx: capSatsSchema,
    maxPerDay: capSatsSchema,
    maxTotal: capSatsSchema,
  })
  .transform(
    (entry): CurrencyPolicy => ({
      currency: entry.currency,
      maxPerTxSats: entry.maxPerTx,
      maxPerDaySats: entry.maxPerDay,
      maxTotalSats: entry.maxTotal,
    }),
  );

const facilitatorEntrySchema = z
  .strictObject({
    name: z.string().min(1).max(64),
    address: z.string().min(1),
    currency: z.string().min(1),
    maxPerTx: capSatsSchema,
    maxPerDay: capSatsSchema,
    autoApprove: z.boolean(),
    // http(s) base URL of the facilitator's v402 API — prepaid-balance
    // queries plus the paid-fetch offer-facilitator pin (see interface doc).
    apiUrl: z.string().url().max(512).optional(),
  })
  .transform(
    (entry): FacilitatorPolicy => ({
      name: entry.name,
      address: entry.address,
      currency: entry.currency,
      maxPerTxSats: entry.maxPerTx,
      maxPerDaySats: entry.maxPerDay,
      autoApprove: entry.autoApprove,
      ...(entry.apiUrl !== undefined ? { apiUrl: entry.apiUrl } : {}),
    }),
  );

const recipientEntrySchema = z.strictObject({
  name: z.string().min(1).max(64),
  address: z.string().min(1),
});

/**
 * A service origin: http(s), host only — any path, query, fragment or
 * credentials in the configured value is a parse error (the request path is
 * the AGENT's per-call input; the policy pins the origin and nothing else).
 * Normalized to `URL.origin` so string comparison is canonical.
 */
const serviceOriginSchema = z
  .string()
  .max(512)
  .transform((value, ctx): string => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: `not a valid URL: ${value}` });
      return z.NEVER;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      ctx.addIssue({ code: "custom", message: `origin must be http(s): ${value}` });
      return z.NEVER;
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
      ctx.addIssue({
        code: "custom",
        message: `origin must not carry a path, query, fragment or credentials: ${value}`,
      });
      return z.NEVER;
    }
    return url.origin;
  });

const serviceEntrySchema = z
  .strictObject({
    name: z.string().min(1).max(64),
    origin: serviceOriginSchema,
    facilitator: z.string().min(1).max(64),
    currency: z.string().min(1),
    maxPricePerCall: capSatsSchema,
    maxPerDay: capSatsSchema,
    autoApprove: z.boolean(),
  })
  .transform(
    (entry): ServicePolicy => ({
      name: entry.name,
      origin: entry.origin,
      facilitator: entry.facilitator,
      currency: entry.currency,
      maxPricePerCallSats: entry.maxPricePerCall,
      maxPerDaySats: entry.maxPerDay,
      autoApprove: entry.autoApprove,
    }),
  );

const rateSchema = z.strictObject({
  maxSendsPerHour: z.number().int().min(1).max(60),
  minSecondsBetweenSends: z.number().int().min(0).max(3600),
  dedupeWindowSeconds: z.number().int().min(0).max(3600),
});

/**
 * The full `policy.json` schema. Cross-field rules that zod cannot express
 * per field live in the superRefine:
 *
 * - the chain-native currency MUST have a cap entry (everything native is
 *   otherwise unspendable, which would brick the wallet silently);
 * - currency entries must be unique (two entries for one currency would
 *   make "the" applicable cap ambiguous);
 * - a facilitator may hold one budget entry PER currency, but (name,
 *   currency) pairs must be unique and one name must always map to one
 *   address (the MCP layer resolves BY NAME — ambiguity is unresolvable);
 * - recipient names must be unique for the same reason;
 * - every facilitator's currency must have a cap entry (an entry in an
 *   unconfigured currency is dead config the operator believes is live);
 * - service names and origins must be unique, and every service must
 *   reference an existing facilitator budget entry IN ITS CURRENCY that has
 *   an `apiUrl` — paid-fetch verifies the 402 offer clears through exactly
 *   that facilitator API, so a service without that link could never pay
 *   (dead config the operator believes is live).
 *
 * `services` defaults to [] so pre-0.2.0 policy files keep loading.
 */
export const policyFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    network: z.enum(SUPPORTED_CHAINS),
    agentAddress: z.string().min(1),
    addressMode: z.enum(["starter-r-address", "verusid"]),
    currencies: z.array(currencyEntrySchema).min(1),
    facilitators: z.array(facilitatorEntrySchema).max(16),
    recipients: z.array(recipientEntrySchema).max(64),
    services: z.array(serviceEntrySchema).max(64).default([]),
    rate: rateSchema,
    armRequired: z.boolean(),
    confirmTimeoutSeconds: z.number().int().min(30).max(600),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((policy, ctx) => {
    const native = nativeCurrencyOf(policy.network);
    const configured = new Set<string>();
    for (const [index, entry] of policy.currencies.entries()) {
      if (configured.has(entry.currency)) {
        ctx.addIssue({
          code: "custom",
          path: ["currencies", index, "currency"],
          message: `duplicate currency entry: ${entry.currency}`,
        });
      }
      configured.add(entry.currency);
    }
    if (!configured.has(native)) {
      ctx.addIssue({
        code: "custom",
        path: ["currencies"],
        message: `missing required cap entry for the chain-native currency ${native}`,
      });
    }
    const facilitatorAddressByName = new Map<string, string>();
    const facilitatorPairs = new Set<string>();
    for (const [index, entry] of policy.facilitators.entries()) {
      const pair = `${entry.name}\n${entry.currency}`;
      if (facilitatorPairs.has(pair)) {
        ctx.addIssue({
          code: "custom",
          path: ["facilitators", index],
          message: `duplicate facilitator entry: ${entry.name} / ${entry.currency}`,
        });
      }
      facilitatorPairs.add(pair);
      const knownAddress = facilitatorAddressByName.get(entry.name);
      if (knownAddress !== undefined && knownAddress !== entry.address) {
        ctx.addIssue({
          code: "custom",
          path: ["facilitators", index, "address"],
          message: `facilitator "${entry.name}" maps to conflicting addresses`,
        });
      }
      facilitatorAddressByName.set(entry.name, entry.address);
      if (!configured.has(entry.currency)) {
        ctx.addIssue({
          code: "custom",
          path: ["facilitators", index, "currency"],
          message: `facilitator "${entry.name}" uses unconfigured currency ${entry.currency}`,
        });
      }
    }
    const recipientNames = new Set<string>();
    for (const [index, entry] of policy.recipients.entries()) {
      if (recipientNames.has(entry.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["recipients", index, "name"],
          message: `duplicate recipient name: ${entry.name}`,
        });
      }
      recipientNames.add(entry.name);
    }
    const serviceNames = new Set<string>();
    const serviceOrigins = new Set<string>();
    for (const [index, entry] of policy.services.entries()) {
      if (serviceNames.has(entry.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["services", index, "name"],
          message: `duplicate service name: ${entry.name}`,
        });
      }
      serviceNames.add(entry.name);
      if (serviceOrigins.has(entry.origin)) {
        ctx.addIssue({
          code: "custom",
          path: ["services", index, "origin"],
          message: `duplicate service origin: ${entry.origin}`,
        });
      }
      serviceOrigins.add(entry.origin);
      const funding = policy.facilitators.find(
        (candidate) =>
          candidate.name === entry.facilitator && candidate.currency === entry.currency,
      );
      if (funding === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["services", index, "facilitator"],
          message:
            `service "${entry.name}" references facilitator "${entry.facilitator}" which has ` +
            `no ${entry.currency} budget entry`,
        });
      } else if (funding.apiUrl === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["services", index, "facilitator"],
          message:
            `service "${entry.name}" needs facilitator "${entry.facilitator}" to have an ` +
            `apiUrl — paid-fetch must verify the 402 offer clears through that facilitator`,
        });
      }
    }
  });

/** The JSON-safe `policy.json` shape (what the CLI writes to disk). */
export type PolicyFileInput = z.input<typeof policyFileSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Parse and validate decoded `policy.json` content into a runtime Policy.
 *
 * Pure — no IO, no clock. Throws:
 * - `PolicyParseError` when the input does not match the strict schema;
 * - `PolicyLimitError` when the chain-native cap entry exceeds the
 *   compiled hard caps for the policy's address mode. This is the check
 *   that makes hand-editing `policy.json` unable to widen the ceiling.
 */
export function parsePolicy(json: unknown): Policy {
  const result = policyFileSchema.safeParse(json);
  if (!result.success) {
    throw new PolicyParseError(`policy.json is invalid: ${formatIssues(result.error)}`);
  }
  const policy: Policy = result.data;

  const nativeCurrency = nativeCurrencyOf(policy.network);
  const native = policy.currencies.find((entry) => entry.currency === nativeCurrency);
  // The schema guarantees the entry exists; keep the runtime check honest.
  if (native === undefined) {
    throw new PolicyParseError(`policy.json is missing the ${nativeCurrency} cap entry`);
  }

  const hardCaps = hardCapsFor(policy.addressMode);
  const checks = [
    ["maxPerTx", native.maxPerTxSats, hardCaps.maxPerTxSats],
    ["maxPerDay", native.maxPerDaySats, hardCaps.maxPerDaySats],
    ["maxTotal", native.maxTotalSats, hardCaps.maxTotalSats],
  ] as const;
  for (const [field, configured, cap] of checks) {
    if (configured > cap) {
      throw new PolicyLimitError(
        `${nativeCurrency} ${field} of ${formatAmount(configured)} exceeds the compiled ` +
          `hard cap of ${formatAmount(cap)} for address mode "${policy.addressMode}"`,
      );
    }
  }

  // Paid-fetch services in the native currency are bounded by their own
  // compiled ceiling (same file-edit-proof rationale; non-native services
  // are bounded solely by their mandatory policy caps).
  const paidFetchCaps = paidFetchHardCapsFor(policy.addressMode);
  for (const service of policy.services) {
    // Case-insensitive: a service priced in a differently-cased spelling of
    // the native currency must not skip the compiled paid-fetch ceiling.
    if (!isNativeCurrency(service.currency, policy.network)) {
      continue;
    }
    const serviceChecks = [
      ["maxPricePerCall", service.maxPricePerCallSats, paidFetchCaps.maxPerCallSats],
      ["maxPerDay", service.maxPerDaySats, paidFetchCaps.maxPerDaySats],
    ] as const;
    for (const [field, configured, cap] of serviceChecks) {
      if (configured > cap) {
        throw new PolicyLimitError(
          `service "${service.name}" ${field} of ${formatAmount(configured)} exceeds the ` +
            `compiled paid-fetch hard cap of ${formatAmount(cap)} for address mode ` +
            `"${policy.addressMode}"`,
        );
      }
    }
  }

  return policy;
}
