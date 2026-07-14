/**
 * The policy engine — Peculium's security core.
 *
 * Pure and deterministic on purpose: no IO, no Date.now(), no randomness.
 * Every input it judges by — the intent, the policy, the ledger aggregates,
 * the operator state, the clock — arrives as a parameter, so every decision
 * is exactly reproducible in a test and in an audit review.
 *
 * Checks run in a FIXED order and the first failure wins. The order is
 * itself a security property: the cheap structural refusals (network pin,
 * intent shape, compiled hard caps) come before anything that consults
 * configuration, so no misconfigured policy can reorder its way around the
 * compiled ceiling. Tiering (auto vs confirm) is decided LAST — an intent
 * only reaches it after clearing every limit.
 *
 * "Day" everywhere means a trailing 24h window, never a calendar day
 * (RISKS.md: no midnight-reset gaming, no timezone questions).
 */

import { formatAmount } from "verus-rpc";

import {
  intentFingerprint,
  REQUEST_ID_PATTERN,
  type PaidFetchIntent,
  type SpendIntent,
} from "../intents.js";
import {
  hardCapsFor,
  isNativeCurrency,
  paidFetchHardCapsFor,
  SUPPORTED_CHAINS,
  wireNetworkOf,
} from "../limits.js";
import type { WalletState } from "../state.js";
import type { FacilitatorPolicy, Policy, ServicePolicy } from "./schema.js";

/**
 * The ledger aggregates the engine consumes. The engine OWNS this contract;
 * the real append-only ledger (E2) implements it. All windows are trailing,
 * measured back from the injected `now`, in milliseconds.
 *
 * Implementations must count every non-terminally-failed attempt (pending,
 * broadcast, ambiguous, confirmed, settled) — anything that might have
 * moved money counts against the caps (fail closed).
 *
 * The two money categories NEVER mix (paid-fetch burns prepaid credit that
 * already left the wallet at topup time): the on-chain aggregates
 * (`spentInWindowSats`, `facilitatorSpentInWindowSats`, `totalSpentSats`,
 * `attemptsInWindow`, `lastAttemptAt`) exclude paid-fetch requests, and the
 * paid-fetch aggregates count nothing else.
 */
export interface LedgerView {
  /** Total spent ON-CHAIN in `currency` within the trailing window. */
  spentInWindowSats(currency: string, windowMs: number, now: Date): bigint;
  /** Total spent to one facilitator address in `currency` within the window. */
  facilitatorSpentInWindowSats(
    address: string,
    currency: string,
    windowMs: number,
    now: Date,
  ): bigint;
  /** Lifetime total spent ON-CHAIN in `currency` (the maxTotal aggregate). */
  totalSpentSats(currency: string): bigint;
  /** Number of ON-CHAIN spend attempts (any currency) within the window. */
  attemptsInWindow(windowMs: number, now: Date): number;
  /** Timestamp of the most recent ON-CHAIN spend attempt, or null if none. */
  lastAttemptAt(): Date | null;
  /** Whether an identical fingerprint was attempted within the window. */
  hasFingerprintInWindow(fingerprint: string, windowMs: number, now: Date): boolean;
  /** Total PAID-FETCH spend in `currency` within the trailing window. */
  paidFetchSpentInWindowSats(currency: string, windowMs: number, now: Date): bigint;
  /** Paid-fetch spend at one service origin in `currency` within the window. */
  serviceSpentInWindowSats(
    origin: string,
    currency: string,
    windowMs: number,
    now: Date,
  ): bigint;
}

/** Why an otherwise-allowed intent still needs a human. */
export type ConfirmReason =
  | "send-always-confirms"
  | "facilitator-currency-mismatch"
  | "facilitator-per-tx-exceeded"
  | "facilitator-per-day-exceeded"
  | "facilitator-not-auto-approve"
  | "service-not-auto-approve";

export type DenyCode =
  | "network-not-supported"
  | "invalid-intent"
  | "hard-cap-per-tx-exceeded"
  | "hard-cap-per-day-exceeded"
  | "hard-cap-total-exceeded"
  | "currency-not-configured"
  | "facilitator-not-listed"
  | "recipient-not-listed"
  | "not-armed"
  | "grant-currency-mismatch"
  | "grant-exceeded"
  | "per-tx-cap-exceeded"
  | "daily-cap-exceeded"
  | "total-cap-exceeded"
  | "rate-limit-exceeded"
  | "min-interval-not-elapsed"
  | "duplicate-intent"
  | "service-not-listed"
  | "service-facilitator-unlinked"
  | "offer-network-mismatch"
  | "offer-currency-mismatch"
  | "offer-domain-mismatch"
  | "offer-facilitator-mismatch"
  | "paid-fetch-hard-cap-per-call-exceeded"
  | "paid-fetch-hard-cap-per-day-exceeded"
  | "service-price-cap-exceeded"
  | "service-daily-cap-exceeded";

/**
 * The engine's verdict. Every deny carries a machine code (for the ledger,
 * audit trail and tests) AND a human sentence (surfaced verbatim to the
 * agent/operator, so it must be understandable without the code table).
 */
export type Decision =
  | { verdict: "auto" }
  | { verdict: "confirm"; reason: ConfirmReason }
  | { verdict: "deny"; reasonCode: DenyCode; humanText: string };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function deny(reasonCode: DenyCode, humanText: string): Decision {
  return { verdict: "deny", reasonCode, humanText };
}

function confirm(reason: ConfirmReason): Decision {
  return { verdict: "confirm", reason };
}

/** `at` (ISO string) is still in the future; the boundary instant counts as expired. */
function isFuture(at: string, now: Date): boolean {
  return new Date(at).getTime() > now.getTime();
}

/**
 * Evaluate one spend intent against policy, ledger aggregates and operator
 * state. Ordered checks, first failure wins:
 *
 *  1. network pin           7. grant (currency + remaining budget)
 *  2. intent shape          8. per-currency caps (per-tx, day, total)
 *  3. compiled hard caps    9. rate (attempts/hour, min interval)
 *  4. currency configured  10. fingerprint dedupe
 *  5. recipient allowlist  11. tier: send ⇒ confirm; topup ⇒ auto only
 *  6. arm window                within the facilitator's own budget
 */
export function evaluatePolicy(
  intent: SpendIntent,
  policy: Policy,
  ledger: LedgerView,
  state: WalletState,
  now: Date,
): Decision {
  // 1. Network pin — a build only ever operates the chains it was compiled
  // for; a policy for anything else is refused regardless of content.
  if (!(SUPPORTED_CHAINS as readonly string[]).includes(policy.network)) {
    return deny(
      "network-not-supported",
      `This build does not operate on network "${policy.network}".`,
    );
  }

  // 2. Intent shape re-validation — the MCP layer validated the raw input,
  // but the engine re-checks because it must not trust its callers.
  if (intent.amountSats <= 0n) {
    return deny("invalid-intent", "The amount must be greater than zero.");
  }
  if (!REQUEST_ID_PATTERN.test(intent.requestId)) {
    return deny("invalid-intent", "The requestId must be 8-64 characters of [A-Za-z0-9._-].");
  }
  if (
    intent.currency.length === 0 ||
    intent.recipientAddress.length === 0 ||
    intent.recipientName.length === 0
  ) {
    return deny("invalid-intent", "The intent is missing a currency or recipient.");
  }

  const amount = intent.amountSats;
  const pretty = `${formatAmount(amount)} ${intent.currency}`;

  // 3. Compiled hard caps — chain-native currency only; the file-edit-proof
  // ceiling that binds even if policy.json was tampered with. The native
  // check is case-insensitive so a lower/mixed-case spelling cannot slip
  // past the compiled ceiling (isNativeCurrency).
  if (isNativeCurrency(intent.currency, policy.network)) {
    const hard = hardCapsFor(policy.addressMode);
    if (amount > hard.maxPerTxSats) {
      return deny(
        "hard-cap-per-tx-exceeded",
        `${pretty} exceeds the compiled per-transaction hard cap of ` +
          `${formatAmount(hard.maxPerTxSats)} ${intent.currency}.`,
      );
    }
    const spentDay = ledger.spentInWindowSats(intent.currency, DAY_MS, now);
    if (spentDay + amount > hard.maxPerDaySats) {
      return deny(
        "hard-cap-per-day-exceeded",
        `${pretty} would exceed the compiled 24h hard cap of ` +
          `${formatAmount(hard.maxPerDaySats)} ${intent.currency} ` +
          `(${formatAmount(spentDay)} already spent).`,
      );
    }
    const spentTotal = ledger.totalSpentSats(intent.currency);
    if (spentTotal + amount > hard.maxTotalSats) {
      return deny(
        "hard-cap-total-exceeded",
        `${pretty} would exceed the compiled lifetime hard cap of ` +
          `${formatAmount(hard.maxTotalSats)} ${intent.currency} ` +
          `(${formatAmount(spentTotal)} already spent).`,
      );
    }
  }

  // 4. Currency must be configured — a currency without a cap entry is
  // unspendable (fail closed; the hard-cap answer for arbitrary tokens).
  const currencyCaps = policy.currencies.find((entry) => entry.currency === intent.currency);
  if (currencyCaps === undefined) {
    return deny(
      "currency-not-configured",
      `Currency ${intent.currency} has no cap entry in the policy and is not spendable.`,
    );
  }

  // 5. Recipient resolution — the resolved (name, address) pair must match
  // an allowlist entry exactly. Topups resolve against facilitators, sends
  // against recipients; the lists are not interchangeable.
  let facilitatorEntries: FacilitatorPolicy[] = [];
  if (intent.kind === "topup") {
    facilitatorEntries = policy.facilitators.filter(
      (entry) => entry.address === intent.recipientAddress && entry.name === intent.recipientName,
    );
    if (facilitatorEntries.length === 0) {
      return deny(
        "facilitator-not-listed",
        `"${intent.recipientName}" (${intent.recipientAddress}) is not an allowlisted facilitator.`,
      );
    }
  } else {
    const recipient = policy.recipients.find(
      (entry) => entry.address === intent.recipientAddress && entry.name === intent.recipientName,
    );
    if (recipient === undefined) {
      return deny(
        "recipient-not-listed",
        `"${intent.recipientName}" (${intent.recipientAddress}) is not an allowlisted recipient.`,
      );
    }
  }

  // 6. Arm window — if the operator requires arming, the wallet must be
  // armed NOW; armedUntil at exactly `now` counts as already expired.
  if (policy.armRequired) {
    if (state.armedUntil === null || !isFuture(state.armedUntil, now)) {
      return deny(
        "not-armed",
        "The wallet is not armed. Ask the operator to run `peculium arm`.",
      );
    }
  }

  // 7. Grant — an active grant is an ADDITIONAL ceiling, per currency. An
  // expired grant is simply no grant; absence of a grant never denies
  // (arming, when required, was already checked above).
  const grant = state.grant;
  if (grant !== null && isFuture(grant.expiresAt, now)) {
    if (grant.currency !== intent.currency) {
      return deny(
        "grant-currency-mismatch",
        `The active grant covers ${grant.currency}, not ${intent.currency}.`,
      );
    }
    if (amount > grant.remainingSats) {
      return deny(
        "grant-exceeded",
        `${pretty} exceeds the remaining grant of ` +
          `${formatAmount(grant.remainingSats)} ${grant.currency}.`,
      );
    }
  }

  // 8. Per-currency policy caps: per-tx, then trailing-24h, then lifetime.
  if (amount > currencyCaps.maxPerTxSats) {
    return deny(
      "per-tx-cap-exceeded",
      `${pretty} exceeds the per-transaction cap of ` +
        `${formatAmount(currencyCaps.maxPerTxSats)} ${intent.currency}.`,
    );
  }
  const spentDay = ledger.spentInWindowSats(intent.currency, DAY_MS, now);
  if (spentDay + amount > currencyCaps.maxPerDaySats) {
    return deny(
      "daily-cap-exceeded",
      `${pretty} would exceed the 24h cap of ` +
        `${formatAmount(currencyCaps.maxPerDaySats)} ${intent.currency} ` +
        `(${formatAmount(spentDay)} already spent).`,
    );
  }
  const spentTotal = ledger.totalSpentSats(intent.currency);
  if (spentTotal + amount > currencyCaps.maxTotalSats) {
    return deny(
      "total-cap-exceeded",
      `${pretty} would exceed the lifetime cap of ` +
        `${formatAmount(currencyCaps.maxTotalSats)} ${intent.currency} ` +
        `(${formatAmount(spentTotal)} already spent).`,
    );
  }

  // 9. Rate limits — attempts count across ALL currencies (they throttle an
  // injection loop, which does not care what it drains).
  if (ledger.attemptsInWindow(HOUR_MS, now) >= policy.rate.maxSendsPerHour) {
    return deny(
      "rate-limit-exceeded",
      `The rate limit of ${policy.rate.maxSendsPerHour} sends per hour is exhausted.`,
    );
  }
  const minIntervalMs = policy.rate.minSecondsBetweenSends * 1000;
  if (minIntervalMs > 0) {
    const last = ledger.lastAttemptAt();
    if (last !== null && now.getTime() - last.getTime() < minIntervalMs) {
      return deny(
        "min-interval-not-elapsed",
        `Sends must be at least ${policy.rate.minSecondsBetweenSends} seconds apart.`,
      );
    }
  }

  // 10. Fingerprint dedupe — an identical transfer (same kind, address,
  // currency, amount; requestId irrelevant) inside the window is refused.
  const dedupeWindowMs = policy.rate.dedupeWindowSeconds * 1000;
  if (dedupeWindowMs > 0) {
    if (ledger.hasFingerprintInWindow(intentFingerprint(intent), dedupeWindowMs, now)) {
      return deny(
        "duplicate-intent",
        `An identical transfer was already attempted within the last ` +
          `${policy.rate.dedupeWindowSeconds} seconds.`,
      );
    }
  }

  // 11. Tier — decided last, only for intents inside every limit. Sends
  // ALWAYS require a human (DESIGN.md §10 decision 2); topups may run
  // unattended only inside the facilitator's own budget with autoApprove.
  if (intent.kind === "send") {
    return confirm("send-always-confirms");
  }
  const facilitator = facilitatorEntries.find((entry) => entry.currency === intent.currency);
  if (facilitator === undefined) {
    return confirm("facilitator-currency-mismatch");
  }
  if (amount > facilitator.maxPerTxSats) {
    return confirm("facilitator-per-tx-exceeded");
  }
  const facilitatorSpentDay = ledger.facilitatorSpentInWindowSats(
    facilitator.address,
    intent.currency,
    DAY_MS,
    now,
  );
  if (facilitatorSpentDay + amount > facilitator.maxPerDaySats) {
    return confirm("facilitator-per-day-exceeded");
  }
  if (!facilitator.autoApprove) {
    return confirm("facilitator-not-auto-approve");
  }
  return { verdict: "auto" };
}

/** Case-insensitive host comparison; `domain` may or may not carry a port. */
function domainMatchesOrigin(domain: string, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const normalized = domain.toLowerCase();
  return normalized === url.hostname.toLowerCase() || normalized === url.host.toLowerCase();
}

/** True when both URLs parse and share an origin (scheme + host + port). */
function sameHttpOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Evaluate one PAID-FETCH intent (an off-chain v402 payment against prepaid
 * credit) — the parallel decision path to {@link evaluatePolicy}. Same
 * philosophy: pure, deterministic, ordered checks, first failure wins,
 * tiering last. The intent carries the 402 offer's claims (price, asset,
 * network, domain, facilitator), all read BEFORE anything was signed — this
 * function is the price gate the client library does not provide.
 *
 *  1. network pin              5. offer pins (currency, domain, facilitator)
 *  2. intent shape             6. arm window
 *  3. compiled paid-fetch      7. price cap (per call)
 *     hard caps (native)       8. service daily budget
 *  4. service allowlist        9. tier: autoApprove ⇒ auto, else confirm
 *
 * Deliberate differences from the on-chain path, recorded in RISKS.md:
 * grants and the send rate limits do not apply (they govern WALLET funds;
 * paid-fetch burns prepaid credit at its own high call frequency), and
 * there is no dedupe window (repeating an identical API call is the normal
 * case, and the requestId idempotency layer still holds).
 */
export function evaluatePaidFetch(
  intent: PaidFetchIntent,
  policy: Policy,
  ledger: LedgerView,
  state: WalletState,
  now: Date,
): Decision {
  // 1. Network pin — same rule as the on-chain path.
  if (!(SUPPORTED_CHAINS as readonly string[]).includes(policy.network)) {
    return deny(
      "network-not-supported",
      `This build does not operate on network "${policy.network}".`,
    );
  }

  // 2. Intent shape re-validation.
  if (intent.amountSats <= 0n) {
    return deny("invalid-intent", "The offered price must be greater than zero.");
  }
  if (!REQUEST_ID_PATTERN.test(intent.requestId)) {
    return deny("invalid-intent", "The requestId must be 8-64 characters of [A-Za-z0-9._-].");
  }
  if (
    intent.currency.length === 0 ||
    intent.recipientAddress.length === 0 ||
    intent.recipientName.length === 0 ||
    !intent.path.startsWith("/") ||
    intent.method.length === 0
  ) {
    return deny("invalid-intent", "The intent is missing a currency, service or request path.");
  }

  const amount = intent.amountSats;
  const pretty = `${formatAmount(amount)} ${intent.currency}`;

  // 3. Compiled paid-fetch hard caps — chain-native currency only, the
  // file-edit-proof ceiling on burning prepaid credit (case-insensitive
  // native check, mirroring the on-chain path).
  if (isNativeCurrency(intent.currency, policy.network)) {
    const hard = paidFetchHardCapsFor(policy.addressMode);
    if (amount > hard.maxPerCallSats) {
      return deny(
        "paid-fetch-hard-cap-per-call-exceeded",
        `${pretty} exceeds the compiled per-call paid-fetch hard cap of ` +
          `${formatAmount(hard.maxPerCallSats)} ${intent.currency}.`,
      );
    }
    const spentDay = ledger.paidFetchSpentInWindowSats(intent.currency, DAY_MS, now);
    if (spentDay + amount > hard.maxPerDaySats) {
      return deny(
        "paid-fetch-hard-cap-per-day-exceeded",
        `${pretty} would exceed the compiled 24h paid-fetch hard cap of ` +
          `${formatAmount(hard.maxPerDaySats)} ${intent.currency} ` +
          `(${formatAmount(spentDay)} already spent).`,
      );
    }
  }

  // 4. Service allowlist — the resolved (name, origin) pair must match an
  // entry exactly (the gate resolved it, the engine re-checks).
  const service: ServicePolicy | undefined = policy.services.find(
    (entry) => entry.name === intent.recipientName && entry.origin === intent.recipientAddress,
  );
  if (service === undefined) {
    return deny(
      "service-not-listed",
      `"${intent.recipientName}" (${intent.recipientAddress}) is not an allowlisted paid service.`,
    );
  }
  const facilitator = policy.facilitators.find(
    (entry) => entry.name === service.facilitator && entry.currency === service.currency,
  );
  if (facilitator === undefined || facilitator.apiUrl === undefined) {
    // The schema forbids this; keep the runtime check honest (fail closed).
    return deny(
      "service-facilitator-unlinked",
      `Service "${service.name}" has no linked facilitator with an apiUrl in the current policy.`,
    );
  }

  // 5. Offer pins — every claim of the 402 offer that could redirect the
  // payment is matched against operator-configured values. A mismatch is a
  // deny, never a confirm: a human cannot verify a rogue offer either.
  // The wire carries the LOWERCASE network id (protocol canonical form);
  // anything else — another chain or a protocol-invalid casing — is a deny.
  if (intent.offerNetwork !== wireNetworkOf(policy.network)) {
    return deny(
      "offer-network-mismatch",
      `The 402 offer is on network "${intent.offerNetwork}", not ` +
        `${wireNetworkOf(policy.network)} (${policy.network}).`,
    );
  }
  if (intent.currency !== service.currency) {
    return deny(
      "offer-currency-mismatch",
      `The 402 offer prices in ${intent.currency}, but service "${service.name}" is ` +
        `configured for ${service.currency}.`,
    );
  }
  if (!domainMatchesOrigin(intent.canonicalDomain, service.origin)) {
    return deny(
      "offer-domain-mismatch",
      `The 402 offer would bind the payment to domain "${intent.canonicalDomain}", which is ` +
        `not the allowlisted origin ${service.origin} — refusing to sign a payment that ` +
        `could be replayed elsewhere.`,
    );
  }
  if (!sameHttpOrigin(intent.offerFacilitator, facilitator.apiUrl)) {
    return deny(
      "offer-facilitator-mismatch",
      `The 402 offer clears through "${intent.offerFacilitator}", but service ` +
        `"${service.name}" is funded via "${facilitator.name}" (${facilitator.apiUrl}).`,
    );
  }

  // 6. Arm window — the operator's global enablement switch applies to
  // every money category.
  if (policy.armRequired) {
    if (state.armedUntil === null || !isFuture(state.armedUntil, now)) {
      return deny(
        "not-armed",
        "The wallet is not armed. Ask the operator to run `peculium arm`.",
      );
    }
  }

  // 7./8. The price gate: per-call cap, then the service's trailing-24h
  // budget. Over-budget is a DENY, not a confirm — paid-fetch is
  // high-frequency and a per-call human escalation would train
  // rubber-stamping; the operator widens budgets via the CLI instead.
  if (amount > service.maxPricePerCallSats) {
    return deny(
      "service-price-cap-exceeded",
      `The offered price of ${pretty} exceeds the per-call cap of ` +
        `${formatAmount(service.maxPricePerCallSats)} ${service.currency} for service ` +
        `"${service.name}".`,
    );
  }
  const serviceSpentDay = ledger.serviceSpentInWindowSats(
    service.origin,
    service.currency,
    DAY_MS,
    now,
  );
  if (serviceSpentDay + amount > service.maxPerDaySats) {
    return deny(
      "service-daily-cap-exceeded",
      `${pretty} would exceed the 24h budget of ${formatAmount(service.maxPerDaySats)} ` +
        `${service.currency} for service "${service.name}" ` +
        `(${formatAmount(serviceSpentDay)} already spent).`,
    );
  }

  // 9. Tier — inside every limit: autoApprove runs unattended (that is the
  // operating mode paid-fetch is built for); otherwise each call asks the
  // human (an operator choice for expensive services).
  if (!service.autoApprove) {
    return confirm("service-not-auto-approve");
  }
  return { verdict: "auto" };
}
