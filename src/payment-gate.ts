/**
 * The payment gate — the ONLY code path through which PREPAID credit is
 * burned (`wallet_paid_fetch`).
 *
 * A deliberate PARALLEL seam to the on-chain `WalletGate`, not an extension
 * of it (the Etappe's gate-vs-new-seam decision, recorded in RISKS.md):
 * off-chain payments have no txid, no broadcast, no outpoints, no
 * confirmations — and one step the on-chain gate structurally lacks: the
 * UNPAID PREFLIGHT that discovers the price. Forcing both through one class
 * would give every on-chain spend a phantom preflight and every payment a
 * phantom txid. The two gates share what actually is shared — the policy
 * source, the pure engine (`evaluatePaidFetch` lives in policy/engine.ts,
 * the single decision point), the append-only ledger, the audit trail and
 * the confirmer — and nothing else.
 *
 * `PaymentGate.execute` runs the binding sequence:
 *
 *  1. single-flight lock, SHARED with the on-chain gate (busy ⇒ deny)
 *  2. idempotent replay (a known requestId NEVER pays twice) — runs first,
 *     needs no key, so a locked keystore never hides a recorded outcome
 *  3. freshness: policy refresh + state read (any failure ⇒ deny)
 *  4. service resolution against the CURRENT policy (names, never URLs)
 *  5. PRE-OFFER enablement — arm window, identity mode, backend readiness:
 *     every check that needs no offer runs BEFORE any network contact, so a
 *     disarmed / starter-mode / keystore-locked wallet makes no outbound
 *     request at all (the preflight is agent-influenced I/O)
 *  6. UNPAID preflight — a non-402 answer returns as-is (audited, nothing
 *     paid, nothing ledgered); a 402 yields the offer
 *  7. the agent's own maxPrice ceiling (cheapest check on the offer)
 *  8. policy evaluation of the offer (deny ⇒ out, nothing ledgered)
 *  9. human confirmation when the verdict demands it, then FULL
 *     re-evaluation (the offer is NOT re-preflighted: the human approved
 *     THIS price; a stale offer fails at step 11 as payment-rejected)
 * 10. ledger reservation, fsynced BEFORE any signature exists
 * 11. sign the vetted offer + send (backend): 2xx and any definitive
 *     non-402 answer ⇒ settled (counts as spent, fail closed); another
 *     402 ⇒ failed/released; setup failure ⇒ failed/released; no answer
 *     ⇒ ambiguous, stays reserved until `peculium resolve`
 *
 * Every step's failure disposition is fail closed: when in doubt, no
 * signature; once signed headers may have left the machine, the
 * reservation STAYS.
 */

import type { AuditLog } from "./audit.js";
import { renderPaidFetchConfirmMessage, type Confirmer } from "./confirm.js";
import { errorDetail } from "./errors.js";
import type { PaidFetchIntent } from "./intents.js";
import type { RequestSnapshot, SpendLedger } from "./ledger/ledger.js";
import type { FailureStage, SpendApproval } from "./ledger/records.js";
import { SpendLock } from "./lock.js";
import {
  PaymentRejectedError,
  PaymentSetupError,
  PaymentUncertainError,
  type PaidRequest,
  type PaidResponse,
  type PaymentBackend,
  type PaymentOffer,
} from "./payment.js";
import { evaluatePaidFetch, type DenyCode } from "./policy/engine.js";
import type { LoadedPolicy, PolicySource } from "./policy/load.js";
import type { ServicePolicy } from "./policy/schema.js";
import { readState } from "./state-io.js";
import type { WalletState } from "./state.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Engine deny codes plus the payment gate's own. */
export type PaymentGateDenyCode =
  | DenyCode
  | "payment-in-flight"
  | "policy-unreadable"
  | "identity-required"
  | "keystore-locked"
  | "not-armed"
  | "no-elicitation"
  | "human-declined"
  | "confirm-timeout"
  | "ledger-unwritable"
  | "offer-invalid"
  | "preflight-unreachable"
  | "agent-max-price-exceeded";

/** What the MCP layer passes in (validated raw input + resolved policy). */
export interface PaidFetchRequest {
  requestId: string;
  /** Allowlist SERVICE name (resolution happens inside the gate). */
  service: string;
  /** Request-target starting with "/", already schema-validated. */
  path: string;
  /** Uppercase HTTP method. */
  method: string;
  body?: string;
  /** The agent's own optional price ceiling, in satoshis. */
  maxPriceSats?: bigint;
}

/**
 * The result of one `execute` call. "denied" and "failed" are safe no-ops;
 * "settled" carries the response AND the recorded spend; "ambiguous" means
 * the amount stays reserved until resolved; "no-payment-required" means the
 * endpoint answered without demanding payment (nothing paid, nothing
 * ledgered); "replayed" returns the prior outcome of the same requestId.
 */
export type PaidFetchOutcome =
  | {
      status: "settled";
      requestId: string;
      service: string;
      amountSats: bigint;
      currency: string;
      response: PaidResponse;
    }
  | { status: "no-payment-required"; requestId: string; service: string; response: PaidResponse }
  | { status: "denied"; requestId: string; reasonCode: PaymentGateDenyCode; humanText: string }
  | { status: "failed"; requestId: string; stage: FailureStage; humanText: string }
  | { status: "ambiguous"; requestId: string; humanText: string }
  | { status: "replayed"; requestId: string; snapshot: RequestSnapshot };

/** The gate's collaborators — interfaces only; composition happens in mcp.ts. */
export interface PaymentGateDeps {
  policySource: PolicySource;
  ledger: SpendLedger;
  backend: PaymentBackend;
  confirmer: Confirmer;
  audit: AuditLog;
  /** Config dir holding `state.json` (arm window). */
  stateDir: string;
  /** Injectable clock for tests; defaults to the real one. */
  clock?: () => Date;
  /**
   * The single-flight lock. SHARED with the WalletGate in production so an
   * on-chain spend and a paid fetch never both hold a human elicitation at
   * once; defaults to a fresh per-gate lock for standalone tests.
   */
  lock?: SpendLock;
}

/** The payment gate. One instance per wallet process; see the module doc. */
export class PaymentGate {
  private readonly deps: PaymentGateDeps;
  private readonly clock: () => Date;
  private readonly lock: SpendLock;

  constructor(deps: PaymentGateDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => new Date());
    this.lock = deps.lock ?? new SpendLock();
  }

  /**
   * Run one paid-fetch request through the full gate sequence. Never throws
   * for policy, confirmation, offer or payment outcomes — those are typed
   * `PaidFetchOutcome`s; an exception escaping here means the ledger itself
   * failed after credit may have been burned (fail closed, operator
   * attention).
   */
  async execute(request: PaidFetchRequest): Promise<PaidFetchOutcome> {
    // 1. Single-flight lock, non-blocking and SHARED with the on-chain gate
    // — a money operation possibly waiting on a human must not interleave
    // with another (one pending elicitation at a time).
    if (!this.lock.tryAcquire()) {
      return {
        status: "denied",
        requestId: request.requestId,
        reasonCode: "payment-in-flight",
        humanText: "Another money operation is already in flight. Retry after it settles.",
      };
    }
    try {
      return await this.run(request);
    } finally {
      this.lock.release();
    }
  }

  private async run(request: PaidFetchRequest): Promise<PaidFetchOutcome> {
    const { ledger, backend, confirmer, audit, stateDir } = this.deps;

    // 2. Idempotency: a known requestId NEVER pays twice. (Response bodies
    // are not stored in the ledger, so a replay returns the recorded
    // outcome without the body — the tool description says so.)
    const prior = ledger.getOutcome(request.requestId);
    if (prior !== null) {
      return { status: "replayed", requestId: request.requestId, snapshot: prior };
    }

    // 3. Freshness: reload policy + operator state; any failure denies.
    let loaded: LoadedPolicy;
    let state: WalletState;
    try {
      loaded = this.refreshPolicy();
      state = readState(stateDir);
    } catch (error) {
      return this.denyEarly(
        request,
        "policy-unreadable",
        `The policy or wallet state could not be loaded; every payment is denied until a ` +
          `human fixes it: ${errorDetail(error)}`,
      );
    }

    // 4. Service resolution — the agent named an allowlist entry; the URL
    // is built from the POLICY's origin, never from agent input.
    const service = loaded.policy.services.find((entry) => entry.name === request.service);
    if (service === undefined) {
      return this.denyEarly(
        request,
        "service-not-listed",
        `"${request.service}" is not on the paid-service allowlist. Call ` +
          `wallet_list_recipients for the configured names; only the operator can add ` +
          `entries (peculium allow service …).`,
      );
    }

    // 5. Pre-offer enablement — every check that does NOT need the offer
    // runs BEFORE the network preflight, so a disarmed / starter-mode /
    // keystore-locked wallet makes no outbound request at all. This closes
    // the gap where the preflight (agent-chosen method/path/body) would
    // otherwise be an unaudited, unarm-gated channel to the origin.
    if (loaded.policy.armRequired) {
      const armedUntil = state.armedUntil;
      if (armedUntil === null || new Date(armedUntil).getTime() <= this.clock().getTime()) {
        return this.denyEarly(
          request,
          "not-armed",
          "The wallet is not armed. Ask the operator to run `peculium arm` before paid fetches.",
        );
      }
    }
    if (loaded.policy.addressMode !== "verusid") {
      return this.denyEarly(
        request,
        "identity-required",
        "v402 payments are signed by a VerusID; this wallet runs in starter (R-address) " +
          "mode, which cannot pay per request. See docs/IDENTITY-RUNBOOK.md for the upgrade.",
      );
    }
    const setup = backend.setupProblem?.() ?? null;
    if (setup !== null) {
      return this.denyEarly(request, setup.code as PaymentGateDenyCode, setup.message);
    }

    // 6. The unpaid preflight — the price discovery the client library
    // does not separate from paying. No key material is touched here.
    const paidRequest: PaidRequest = {
      url: new URL(service.origin + request.path),
      method: request.method,
      ...(request.body !== undefined ? { body: request.body } : {}),
      agentAddress: loaded.policy.agentAddress,
      network: loaded.policy.network,
    };
    let offer: PaymentOffer;
    try {
      const preflight = await backend.preflight(paidRequest);
      if (preflight.kind === "response") {
        audit.write({
          event: "paid-fetch-no-payment",
          requestId: request.requestId,
          service: service.name,
          httpStatus: preflight.response.httpStatus,
        });
        return {
          status: "no-payment-required",
          requestId: request.requestId,
          service: service.name,
          response: preflight.response,
        };
      }
      offer = preflight.offer;
    } catch (error) {
      const code: PaymentGateDenyCode =
        error instanceof PaymentSetupError && error.code === "preflight-unreachable"
          ? "preflight-unreachable"
          : "offer-invalid";
      return this.denyEarly(request, code, errorDetail(error));
    }

    // The typed intent (agent input + resolved service + vetted offer),
    // built once and reused by the maxPrice deny, the engine and the audit.
    let intent = buildIntent(request, service, offer);

    // 7. The agent's own ceiling — checked before the engine so an agent
    // that budgeted tighter than the operator gets its own clear answer.
    if (request.maxPriceSats !== undefined && offer.amountSats > request.maxPriceSats) {
      return this.deny(
        intent,
        "agent-max-price-exceeded",
        `The offered price exceeds the maxPrice this call allowed.`,
      );
    }

    // 8. Policy evaluation of the CONCRETE offer. A deny leaves no ledger
    // trace — nothing was signed, nothing counts against the budgets.
    let decision = evaluatePaidFetch(intent, loaded.policy, ledger, state, this.clock());
    if (decision.verdict === "deny") {
      return this.deny(intent, decision.reasonCode, decision.humanText);
    }

    let humanConfirmed = false;
    if (decision.verdict === "confirm") {
      // 9. Human confirmation (autoApprove=false services). No channel ⇒
      // fail-closed deny, never a silent auto-approve.
      if (!confirmer.available()) {
        return this.deny(
          intent,
          "no-elicitation",
          "This payment needs a human confirmation, but the connected host does not " +
            "support MCP elicitation. Use a host that does, or have the operator mark the " +
            "service --auto-approve within a tight budget (peculium CLI).",
        );
      }
      audit.write({ event: "confirm-requested", requestId: request.requestId });
      const message = renderPaidFetchConfirmMessage(intent, {
        policy: loaded.policy,
        serviceSpentInWindowSats: ledger.serviceSpentInWindowSats(
          service.origin,
          service.currency,
          DAY_MS,
          this.clock(),
        ),
        serviceCaps: { maxPerDaySats: service.maxPerDaySats },
      });
      const outcome = await confirmer.confirm(
        message,
        loaded.policy.confirmTimeoutSeconds * 1000,
      );
      if (outcome === "denied") {
        audit.write({ event: "confirm-declined", requestId: request.requestId });
        return {
          status: "denied",
          requestId: request.requestId,
          reasonCode: "human-declined",
          humanText: "The human declined this payment.",
        };
      }
      if (outcome !== "approved") {
        audit.write({ event: "confirm-timeout", requestId: request.requestId });
        return {
          status: "denied",
          requestId: request.requestId,
          reasonCode: "confirm-timeout",
          humanText: "No confirmation arrived before the timeout; nothing was paid.",
        };
      }
      audit.write({ event: "confirm-approved", requestId: request.requestId });
      humanConfirmed = true;

      // Re-evaluate with fresh policy/state/clock after the human pause.
      // The OFFER is deliberately not re-preflighted: the human approved
      // exactly this price, and a meanwhile-changed offer fails closed at
      // the pay step (another 402 ⇒ payment-rejected, released).
      let current: ServicePolicy | undefined;
      try {
        loaded = this.refreshPolicy();
        state = readState(stateDir);
        current = loaded.policy.services.find(
          (entry) => entry.name === request.service && entry.origin === service.origin,
        );
      } catch (error) {
        return this.deny(
          intent,
          "policy-unreadable",
          `The policy or wallet state could not be reloaded after confirmation: ` +
            `${errorDetail(error)}`,
        );
      }
      if (current === undefined) {
        return this.deny(
          intent,
          "service-not-listed",
          `"${request.service}" is no longer on the current paid-service allowlist.`,
        );
      }
      intent = buildIntent(request, current, offer);
      decision = evaluatePaidFetch(intent, loaded.policy, ledger, state, this.clock());
      if (decision.verdict === "deny") {
        return this.deny(intent, decision.reasonCode, decision.humanText);
      }
      // A repeated "confirm" verdict is satisfied by the approval above.
    }

    // 10. Reserve: the pending row is durable BEFORE any signature exists.
    const approval: SpendApproval = humanConfirmed ? "human-confirmed" : "auto";
    try {
      ledger.recordPending(intent, approval, loaded.policyHash);
    } catch (error) {
      return {
        status: "denied",
        requestId: request.requestId,
        reasonCode: "ledger-unwritable",
        humanText:
          `The spend ledger could not record the reservation, so nothing was paid: ` +
          `${errorDetail(error)}`,
      };
    }

    // 11. Sign + send. The failure split is the money semantics.
    let response: PaidResponse;
    try {
      response = await backend.pay(paidRequest, offer);
    } catch (error) {
      if (error instanceof PaymentSetupError) {
        // Nothing was signed or sent — a proven no-op, released.
        ledger.recordFailed(request.requestId, "build", { message: error.message });
        return {
          status: "failed",
          requestId: request.requestId,
          stage: "build",
          humanText: `The payment could not be prepared and nothing was sent: ${error.message}`,
        };
      }
      if (error instanceof PaymentRejectedError) {
        // A second 402 normatively reserves nothing — released.
        ledger.recordFailed(request.requestId, "payment-rejected", {
          code: error.httpStatus,
          message: error.message,
        });
        return {
          status: "failed",
          requestId: request.requestId,
          stage: "payment-rejected",
          humanText: error.message,
        };
      }
      // PaymentUncertainError — and ANY unexpected throw: signed headers
      // may be on the wire, so the amount stays reserved (fail closed).
      const uncertain = error instanceof PaymentUncertainError;
      ledger.recordAmbiguous(request.requestId, "payment-transport-error");
      return {
        status: "ambiguous",
        requestId: request.requestId,
        humanText:
          `The payment may or may not have been debited ` +
          `(${uncertain ? error.message : errorDetail(error)}). The amount stays reserved ` +
          `against the paid-fetch budgets until \`peculium resolve\` settles it — the ` +
          `facilitator's signed ledger statement is the evidence source.`,
      };
    }

    // A definitive HTTP answer settles the request. It counts as spent
    // regardless of the status (fail closed — see records.ts); the honest
    // httpStatus is recorded and surfaced.
    ledger.recordSettled(request.requestId, response.httpStatus);
    return {
      status: "settled",
      requestId: request.requestId,
      service: service.name,
      amountSats: intent.amountSats,
      currency: intent.currency,
      response,
    };
  }

  /** Refresh the policy (audit on change) — throws like PolicySource.refresh. */
  private refreshPolicy(): LoadedPolicy {
    const refreshed = this.deps.policySource.refresh();
    if (refreshed.changed) {
      this.deps.audit.write({
        event: "policy-reload",
        oldHash: refreshed.previousHash,
        newHash: refreshed.policy.policyHash,
      });
    }
    return refreshed.policy;
  }

  /** Audit + deny for a fully built intent (offer known). */
  private deny(
    intent: PaidFetchIntent,
    reasonCode: PaymentGateDenyCode,
    humanText: string,
  ): PaidFetchOutcome {
    this.deps.audit.write({
      event: "intent-denied",
      requestId: intent.requestId,
      reasonCode,
      kind: "paid-fetch",
      recipientName: intent.recipientName,
      currency: intent.currency,
      amountSats: intent.amountSats,
    });
    return { status: "denied", requestId: intent.requestId, reasonCode, humanText };
  }

  /** Audit + deny before an offer exists (no amount/currency to record). */
  private denyEarly(
    request: PaidFetchRequest,
    reasonCode: PaymentGateDenyCode,
    humanText: string,
  ): PaidFetchOutcome {
    this.deps.audit.write({
      event: "intent-denied",
      requestId: request.requestId,
      reasonCode,
      kind: "paid-fetch",
      recipientName: request.service,
      currency: "unknown",
      amountSats: 0n,
    });
    return { status: "denied", requestId: request.requestId, reasonCode, humanText };
  }
}

/** The typed intent: agent input + resolved service + vetted offer claims. */
function buildIntent(
  request: PaidFetchRequest,
  service: ServicePolicy,
  offer: PaymentOffer,
): PaidFetchIntent {
  return {
    kind: "paid-fetch",
    requestId: request.requestId,
    amountSats: offer.amountSats,
    currency: offer.asset,
    recipientAddress: service.origin,
    recipientName: service.name,
    method: request.method,
    path: request.path,
    offerNetwork: offer.network,
    payTo: offer.payTo,
    offerFacilitator: offer.facilitator,
    canonicalDomain: offer.canonicalDomain,
  };
}
