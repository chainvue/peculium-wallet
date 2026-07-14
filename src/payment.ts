/**
 * The OFF-CHAIN payment boundary — where a vetted v402 offer becomes a
 * signed payment header on the wire.
 *
 * The payment gate talks to the `PaymentBackend` INTERFACE only, mirroring
 * the `WalletBackend` seam. The production `V402PaymentBackend` implements
 * the v402 handshake in two SEPARATE steps, deliberately not through
 * `V402Client.fetch`/`paidFetch` of @chainvue/v402-client-fetch: that
 * client pays WHATEVER the 402 demands (no price ceiling, no allowlist),
 * and its price-mismatch self-healing re-signs at a NEW, unvetted price.
 * Peculium must inspect the offer BEFORE any signature exists:
 *
 *   1. `preflight` — the unpaid request; returns the parsed offer (or the
 *      response, when the endpoint wanted no payment). No key material is
 *      touched here.
 *   2. `pay` — sign the canonical payload for EXACTLY the vetted offer
 *      (amount byte-verbatim) and send once, with bounded same-requestId
 *      retries on pure network errors (the v402 M5 idempotent-reserve
 *      rule: same ULID + same signature can never double-pay).
 *
 * The error split IS the money semantics, exactly like backend.ts:
 * `PaymentSetupError` and `PaymentRejectedError` are proven no-ops (the
 * signature never left / the answer was another 402, which normatively
 * reserves nothing); `PaymentUncertainError` means the signed headers went
 * out and no answer came back — the gate records `ambiguous` and the
 * amount stays reserved. Any OTHER HTTP status is returned as a response
 * and settles fail-closed (counted as spent; see records.ts).
 */

import { createHash } from "node:crypto";

import { ulid } from "@chainvue/v402-client-fetch";
import {
  canonicalize,
  payment402ResponseSchema,
  paymentRequirementSchema,
  SCHEME_VERUS_PREPAID_SIG,
  serializeExtensionBlock,
  V402_HEADERS,
  type ExtensionField,
  type PaymentRequirement,
} from "@chainvue/v402-protocol";
import { LocalKeySigner, type Signer } from "@chainvue/v402-signer-verus";
import { parseAmount } from "@chainvue/verus-rpc";

import { errorDetail, PeculiumError } from "./errors.js";
import { readKeystoreFile, unlockKeystore } from "./keystore.js";
import { systemIdOf, type SupportedChain } from "./limits.js";
import type { WalletReader } from "./reader.js";

/** One guarded HTTP call, fully specified by the gate (never by the agent). */
export interface PaidRequest {
  /** Absolute URL: allowlisted origin + validated path. */
  url: URL;
  /** Uppercase HTTP method. */
  method: string;
  /** Request body, when the method carries one. */
  body?: string;
  /** The agent identity that pays (policy `agentAddress`, i-address). */
  agentAddress: string;
  network: SupportedChain;
}

/** A bounded, JSON-safe view of an HTTP response. */
export interface PaidResponse {
  httpStatus: number;
  contentType: string | null;
  /** Body content; base64 when `bodyEncoding` says so. */
  body: string;
  bodyEncoding: "utf8" | "base64";
  /** True when the body was cut at the size bound. */
  truncated: boolean;
}

/** The money-relevant claims of a 402 offer, parsed and typed. */
export interface PaymentOffer {
  amountSats: bigint;
  asset: string;
  network: string;
  payTo: string;
  facilitator: string;
  canonicalDomain: string;
  /** The full requirement, signed byte-verbatim by `pay`. */
  requirement: PaymentRequirement;
}

export type PreflightResult =
  | { kind: "response"; response: PaidResponse }
  | { kind: "offer"; offer: PaymentOffer };

/**
 * The payment could not be prepared — keystore locked, payer name
 * unresolvable, malformed offer. Nothing was signed, nothing was sent:
 * a proven no-op (ledger stage "build").
 */
export class PaymentSetupError extends PeculiumError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "PaymentSetupError";
  }
}

/**
 * The paid attempt was answered with ANOTHER 402: the offer changed between
 * preflight and payment. Normative v402 semantics (M5/M6): a 402 answer
 * reserves nothing — a proven no-op, the reservation is released. The
 * caller may retry with a fresh requestId; the new preflight re-runs the
 * price gate against the new offer.
 */
export class PaymentRejectedError extends PeculiumError {
  readonly httpStatus: number;

  constructor(message: string, httpStatus: number) {
    super("payment-rejected", message);
    this.name = "PaymentRejectedError";
    this.httpStatus = httpStatus;
  }
}

/**
 * The signed payment headers went out and no definitive answer came back —
 * the facilitator MAY have debited. The gate records `ambiguous`; the
 * amount stays reserved until `peculium resolve` (the facilitator's signed
 * ledger statement is the evidence source).
 */
export class PaymentUncertainError extends PeculiumError {
  constructor(message: string) {
    super("payment-uncertain", message);
    this.name = "PaymentUncertainError";
  }
}

/** The gate's view of the v402 wire mechanics. */
export interface PaymentBackend {
  /**
   * Readiness check the gate runs BEFORE any network contact: null when the
   * backend could sign a payment right now, or a typed reason it cannot
   * (e.g. keystore locked). Optional — a backend that omits it is treated
   * as always ready. Keeps the "can we pay?" precondition out of the MCP
   * layer and ahead of the unpaid preflight.
   */
  setupProblem?(): { code: string; message: string } | null;
  /** The unpaid request: pass through a non-402 answer, parse a 402 offer. */
  preflight(request: PaidRequest): Promise<PreflightResult>;
  /** Sign EXACTLY `offer` and send. See the error taxonomy above. */
  pay(request: PaidRequest, offer: PaymentOffer): Promise<PaidResponse>;
}

/** Response bodies larger than this are truncated (MCP results are context). */
const MAX_BODY_BYTES = 256 * 1024;

/** Content types decoded as UTF-8 text; everything else returns base64. */
const TEXT_CONTENT = /^(text\/|application\/(json|xml|x-ndjson|javascript)|.*\+(json|xml))/i;

/** Same-requestId resends on pure network errors (v402 M5). */
const TRANSPORT_RETRIES = 2;

/**
 * Per-request wall-clock ceiling. A guarded service that accepts the
 * connection but never answers must not hang the payment mutex forever (a
 * stalled paid fetch would deny every subsequent one "payment-in-flight").
 */
const FETCH_TIMEOUT_MS = 30_000;

/** Fetch init shared by preflight and pay: never follow redirects (a 3xx
 * would forward the SIGNED payment headers to the redirect target's host —
 * fail closed), and bound the wait. */
function fetchInit(request: PaidRequest, headers?: Headers): RequestInit {
  return {
    method: request.method,
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...(headers !== undefined ? { headers } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
  };
}

/**
 * Read at most MAX_BODY_BYTES of the response body, then abort the rest of
 * the transfer. The cap bounds what a (possibly hostile) endpoint can make
 * the wallet allocate — reading the full body first would let a multi-GB
 * answer OOM the money process mid-payment.
 */
async function boundedResponse(response: Response): Promise<PaidResponse> {
  const contentType = response.headers.get("content-type");
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const body = response.body;
  if (body !== null) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value === undefined) {
          continue;
        }
        const remaining = MAX_BODY_BYTES - total;
        if (value.byteLength >= remaining) {
          chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining));
          total += remaining;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        total += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bounded = Buffer.concat(chunks, total);
  const isText = contentType === null || TEXT_CONTENT.test(contentType);
  return {
    httpStatus: response.status,
    contentType,
    body: isText ? bounded.toString("utf8") : bounded.toString("base64"),
    bodyEncoding: isText ? "utf8" : "base64",
    truncated,
  };
}

/**
 * Parse a 402 response body into a typed {@link PaymentOffer}. Throws
 * `PaymentSetupError` (a no-op — nothing was signed) on anything that is
 * not exactly one well-formed verus-prepaid-sig requirement with a valid
 * positive decimal amount.
 */
export async function parse402Offer(response: Response): Promise<PaymentOffer> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new PaymentSetupError("offer-invalid", "the 402 response body is not JSON");
  }
  const envelope = payment402ResponseSchema.safeParse(json);
  if (!envelope.success) {
    throw new PaymentSetupError("offer-invalid", "the 402 response is not a v402 envelope");
  }
  const entry = envelope.data.accepts.find((a) => a.scheme === SCHEME_VERUS_PREPAID_SIG);
  if (entry === undefined) {
    throw new PaymentSetupError(
      "offer-invalid",
      "the 402 offer accepts no scheme this wallet supports (verus-prepaid-sig)",
    );
  }
  const requirement = paymentRequirementSchema.safeParse(entry);
  if (!requirement.success) {
    throw new PaymentSetupError("offer-invalid", "the verus-prepaid-sig offer entry is malformed");
  }
  let amountSats: bigint;
  try {
    amountSats = parseAmount(requirement.data.amount);
  } catch {
    throw new PaymentSetupError(
      "offer-invalid",
      `the 402 offer's amount "${requirement.data.amount}" is not a valid decimal`,
    );
  }
  if (amountSats <= 0n) {
    throw new PaymentSetupError("offer-invalid", "the 402 offer's amount is not positive");
  }
  // Rebuild the exact wire shape (the loose zod parse types `topup` as
  // possibly-undefined, which exactOptionalPropertyTypes rejects).
  const { topup, ...core } = requirement.data;
  const wire: PaymentRequirement = { ...core, ...(topup !== undefined ? { topup } : {}) };
  return {
    amountSats,
    asset: wire.asset,
    network: wire.network,
    payTo: wire.payTo,
    facilitator: wire.facilitator,
    canonicalDomain: wire.canonicalDomain,
    requirement: wire,
  };
}

/** Everything the production backend composes over. */
export interface V402PaymentBackendDeps {
  /** Chain reads: payer name resolution + height for identity signatures. */
  reader: WalletReader;
  /** Config dir holding `keystore.json`. */
  stateDir: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (issuedAt); defaults to the real one. */
  clock?: () => Date;
  /**
   * Signer override for tests. Production reads the keystore at PAY time
   * (passphrase from env, never cached — the LiteBackend discipline).
   */
  makeSigner?: (request: PaidRequest) => Promise<{ payer: string; signer: Signer }>;
}

/** The production {@link PaymentBackend} over fetch + the local keystore. */
export class V402PaymentBackend implements PaymentBackend {
  private readonly deps: V402PaymentBackendDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;

  constructor(deps: V402PaymentBackendDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.clock = deps.clock ?? (() => new Date());
  }

  setupProblem(): { code: string; message: string } | null {
    // A test/DI signer needs no keystore passphrase.
    if (this.deps.makeSigner !== undefined) {
      return null;
    }
    const passphrase = process.env["PECULIUM_KEYSTORE_PASSPHRASE"];
    if (passphrase === undefined || passphrase === "") {
      return {
        code: "keystore-locked",
        message:
          "PECULIUM_KEYSTORE_PASSPHRASE is not set — payments must be signed with the " +
          "wallet identity's key. Configure the passphrase in the MCP host env.",
      };
    }
    return null;
  }

  async preflight(request: PaidRequest): Promise<PreflightResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, fetchInit(request));
    } catch (error) {
      // Nothing was paid or signed — a preflight transport failure (or a
      // refused redirect / timeout) is a clean no-op, surfaced as a setup
      // error (the gate denies).
      throw new PaymentSetupError(
        "preflight-unreachable",
        `the service could not be reached for the unpaid preflight: ${errorDetail(error)}`,
      );
    }
    if (response.status !== 402) {
      return { kind: "response", response: await boundedResponse(response) };
    }
    return { kind: "offer", offer: await parse402Offer(response) };
  }

  async pay(request: PaidRequest, offer: PaymentOffer): Promise<PaidResponse> {
    const { payer, signer } = await this.resolveSigner(request);
    const requirement = offer.requirement;

    // M1: the request-target is built once, signed, and sent verbatim.
    const path = `${request.url.pathname}${request.url.search}`;
    const extensions: ExtensionField[] = [];
    if (request.body !== undefined && request.body.length > 0) {
      const hash = createHash("sha256").update(request.body, "utf8").digest("hex");
      extensions.push({ key: "scheme.bodyHash", value: `sha256:${hash}` });
    }
    const requestId = ulid();
    const issuedAt = Math.floor(this.clock().getTime() / 1000);
    const canonical = canonicalize({
      scheme: requirement.scheme,
      schemeVersion: requirement.schemeVersion,
      canonicalDomain: requirement.canonicalDomain,
      method: request.method,
      path,
      network: requirement.network,
      asset: requirement.asset,
      amount: requirement.amount, // byte-verbatim from the VETTED offer
      payer,
      payTo: requirement.payTo,
      requestId,
      issuedAt,
      ...(extensions.length > 0 ? { extensions } : {}),
    });

    let signature: string;
    try {
      signature = await signer.signMessage(canonical);
    } catch (error) {
      throw new PaymentSetupError(
        "signing-failed",
        `the payment could not be signed (nothing was sent): ${errorDetail(error)}`,
      );
    }

    const headers = new Headers();
    headers.set(V402_HEADERS.scheme, `${requirement.scheme}/${requirement.schemeVersion}`);
    headers.set(V402_HEADERS.payer, payer);
    headers.set(V402_HEADERS.amount, requirement.amount);
    headers.set(V402_HEADERS.requestId, requestId);
    headers.set(V402_HEADERS.issuedAt, String(issuedAt));
    headers.set(V402_HEADERS.signature, signature);
    if (extensions.length > 0) {
      headers.set(
        V402_HEADERS.extensions,
        Buffer.from(serializeExtensionBlock(extensions), "utf8").toString("base64"),
      );
    }

    // Same requestId + same signature on every attempt: the facilitator's
    // reserve is idempotent per ULID, so a resend can never double-pay.
    let lastError: unknown;
    // True once ANY attempt's signed request left the machine without a
    // definitive answer: a later 402 is then no longer a proven no-op (the
    // earlier request may have reached the facilitator and debited before
    // its response was lost).
    let sentUnanswered = false;
    for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(request.url, fetchInit(request, headers));
      } catch (error) {
        lastError = error;
        sentUnanswered = true;
        continue;
      }
      if (response.status === 402) {
        if (sentUnanswered) {
          // A prior attempt may already have paid — do NOT release.
          throw new PaymentUncertainError(
            "a retry of the signed payment was answered with 402, but an earlier attempt " +
              "went unanswered and may have debited the prepaid balance — the amount stays " +
              "reserved until `peculium resolve`",
          );
        }
        throw new PaymentRejectedError(
          "the service answered the paid request with another 402 (the offer changed after " +
            "the preflight) — nothing was reserved; retry with a fresh requestId to re-run " +
            "the price gate against the new offer",
          response.status,
        );
      }
      return await boundedResponse(response);
    }
    throw new PaymentUncertainError(
      `no answer arrived for the signed payment after ${TRANSPORT_RETRIES + 1} attempts ` +
        `(${errorDetail(lastError)}) — the facilitator may have debited the prepaid balance`,
    );
  }

  private async resolveSigner(
    request: PaidRequest,
  ): Promise<{ payer: string; signer: Signer }> {
    if (this.deps.makeSigner !== undefined) {
      return this.deps.makeSigner(request);
    }
    const passphrase = process.env["PECULIUM_KEYSTORE_PASSPHRASE"];
    if (passphrase === undefined || passphrase === "") {
      throw new PaymentSetupError(
        "keystore-locked",
        "PECULIUM_KEYSTORE_PASSPHRASE is not set — the payment must be signed with the " +
          "wallet identity's key",
      );
    }
    let payer: string | null;
    try {
      payer = await this.deps.reader.getFriendlyName(request.agentAddress);
    } catch {
      payer = null;
    }
    if (payer === null) {
      throw new PaymentSetupError(
        "payer-unresolvable",
        "the agent identity's name could not be resolved from the node — cannot build the " +
          "signed payment",
      );
    }
    let signer: Signer;
    try {
      signer = buildIdentitySigner({
        reader: this.deps.reader,
        stateDir: this.deps.stateDir,
        agentAddress: request.agentAddress,
        network: request.network,
        passphrase,
      });
    } catch (error) {
      throw new PaymentSetupError(
        "keystore-locked",
        `the keystore could not be unlocked for signing: ${errorDetail(error)}`,
      );
    }
    return { payer, signer };
  }
}

/**
 * Build the identity signer from the encrypted keystore — the ONE place the
 * wallet turns a passphrase into a `LocalKeySigner` bound to the agent
 * identity. Shared by the payment path and `wallet_prepaid_balance` so
 * keystore/systemId/height semantics can never drift between the two.
 * Throws (keystore missing/locked, bad passphrase) — callers map it to a
 * fail-closed setup error.
 */
export function buildIdentitySigner(opts: {
  reader: WalletReader;
  stateDir: string;
  agentAddress: string;
  network: SupportedChain;
  passphrase: string;
}): Signer {
  const keystore = readKeystoreFile(opts.stateDir);
  const wif = unlockKeystore(keystore, opts.passphrase);
  return new LocalKeySigner(wif, {
    identity: { identityAddress: opts.agentAddress, systemId: systemIdOf(opts.network) },
    heightProvider: async () => {
      const height = await opts.reader.getBlockHeight();
      if (height === null) {
        throw new Error("chain height unavailable for the identity signature");
      }
      return height;
    },
  });
}

/** One scripted MockPaymentBackend behavior, consumed per call in FIFO order. */
type MockPreflightPlan =
  | { kind: "result"; result: PreflightResult }
  | { kind: "throw"; error: Error };
type MockPayPlan = { kind: "respond"; response: PaidResponse } | { kind: "throw"; error: Error };

/**
 * Scriptable in-memory {@link PaymentBackend} for tests (the MockBackend
 * pattern). Script each call up front; an unscripted call throws a plain
 * Error, which the gate treats as uncertain — a test that did not expect a
 * payment fails loudly either way.
 */
export class MockPaymentBackend implements PaymentBackend {
  /** Every preflight request received, in call order. */
  readonly preflights: PaidRequest[] = [];
  /** Every pay call received, in call order. */
  readonly payments: { request: PaidRequest; offer: PaymentOffer }[] = [];

  private readonly preflightPlans: MockPreflightPlan[] = [];
  private readonly payPlans: MockPayPlan[] = [];

  willPreflight(result: PreflightResult): this {
    this.preflightPlans.push({ kind: "result", result });
    return this;
  }

  willPreflightThrow(error: Error): this {
    this.preflightPlans.push({ kind: "throw", error });
    return this;
  }

  willPay(response: PaidResponse): this {
    this.payPlans.push({ kind: "respond", response });
    return this;
  }

  willPayThrow(error: Error): this {
    this.payPlans.push({ kind: "throw", error });
    return this;
  }

  preflight(request: PaidRequest): Promise<PreflightResult> {
    this.preflights.push(request);
    const plan = this.preflightPlans.shift();
    if (plan === undefined) {
      return Promise.reject(new Error("MockPaymentBackend: no scripted preflight left"));
    }
    return plan.kind === "result" ? Promise.resolve(plan.result) : Promise.reject(plan.error);
  }

  pay(request: PaidRequest, offer: PaymentOffer): Promise<PaidResponse> {
    this.payments.push({ request, offer });
    const plan = this.payPlans.shift();
    if (plan === undefined) {
      return Promise.reject(new Error("MockPaymentBackend: no scripted pay left"));
    }
    return plan.kind === "respond" ? Promise.resolve(plan.response) : Promise.reject(plan.error);
  }
}
