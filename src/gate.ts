/**
 * The wallet gate — the ONLY code path through which money moves.
 *
 * `WalletGate.execute` runs the binding sequence from PLAN.md (adapted for
 * lite: `sendrawtransaction` returns the txid synchronously; confirmation
 * TRACKING is E4's reconciler, not the gate):
 *
 *  1. in-process mutex (non-blocking; busy ⇒ deny)
 *  2. idempotent replay (a known requestId NEVER spends twice)
 *  3. freshness: policy refresh + state read (any failure ⇒ deny)
 *  4. defensive recipient re-validation against the CURRENT policy
 *  5. policy evaluation (deny ⇒ out, nothing ledgered)
 *  6. human confirmation when the verdict demands it (fail closed
 *     without an available channel)
 *  7. re-evaluation with fresh policy/state/clock after the human pause
 *  8. ledger reservation, fsynced BEFORE any execution
 *  9. backend execution (rejected ⇒ failed row / uncertain ⇒ ambiguous)
 * 10. broadcast row with txid and outpoints
 * 11. best-effort grant depletion — after the money moved, a state-write
 *     failure must not undo a real spend (stderr warning only)
 *
 * Every step's failure disposition is fail closed: when in doubt, no spend;
 * once bytes may have left the machine, the reservation STAYS.
 */

import type { AuditLog } from "./audit.js";
import { SpendRejectedError, type SpendReceipt, type WalletBackend } from "./backend.js";
import { errorDetail } from "./errors.js";
import { renderConfirmMessage, type Confirmer } from "./confirm.js";
import type { SpendIntent } from "./intents.js";
import type { RequestSnapshot, SpendLedger } from "./ledger/ledger.js";
import { SpendLock } from "./lock.js";
import type { FailureStage, SpendApproval } from "./ledger/records.js";
import { evaluatePolicy, type DenyCode } from "./policy/engine.js";
import type { LoadedPolicy, PolicySource } from "./policy/load.js";
import type { Policy } from "./policy/schema.js";
import { depleteGrant, readState, writeState } from "./state-io.js";
import type { WalletState } from "./state.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything a deny can carry: the engine's codes plus the gate's own.
 * The gate codes cover failures the pure engine cannot see (contention,
 * IO, the confirmation channel).
 */
export type GateDenyCode =
  | DenyCode
  | "spend-in-flight"
  | "policy-unreadable"
  | "no-elicitation"
  | "human-declined"
  | "confirm-timeout"
  | "ledger-unwritable";

/**
 * The result of one `execute` call. "denied" and "failed" are safe
 * no-ops; "ambiguous" means the amount stays reserved until resolved;
 * "replayed" returns the prior outcome of the same requestId without any
 * new spend.
 */
export type GateOutcome =
  | { status: "committed"; requestId: string; txid: string }
  | { status: "denied"; requestId: string; reasonCode: GateDenyCode; humanText: string }
  | { status: "failed"; requestId: string; stage: FailureStage; humanText: string }
  | { status: "ambiguous"; requestId: string; humanText: string }
  | { status: "replayed"; requestId: string; snapshot: RequestSnapshot };

/** The gate's collaborators — interfaces only; composition happens in E4/E5. */
export interface WalletGateDeps {
  policySource: PolicySource;
  ledger: SpendLedger;
  backend: WalletBackend;
  confirmer: Confirmer;
  audit: AuditLog;
  /** Config dir holding `state.json` (arm window + grant). */
  stateDir: string;
  /** Injectable clock for tests; defaults to the real one. */
  clock?: () => Date;
  /**
   * The single-flight lock. SHARED with the PaymentGate in production so
   * only one money operation (one pending elicitation) runs at a time;
   * defaults to a fresh per-gate lock for standalone tests.
   */
  lock?: SpendLock;
}

/**
 * True when the intent's (name, address) pair exactly matches an entry of
 * the list its kind resolves against. The gate re-checks this against the
 * CURRENT policy even though the engine would too — the gate must not
 * trust its caller to have resolved against the same policy generation
 * (v2 boundary: caller and gate may live in different processes).
 */
function recipientListed(intent: SpendIntent, policy: Policy): boolean {
  const entries = intent.kind === "topup" ? policy.facilitators : policy.recipients;
  return entries.some(
    (entry) => entry.name === intent.recipientName && entry.address === intent.recipientAddress,
  );
}


/** The wallet gate. One instance per wallet process; see the module doc. */
export class WalletGate {
  private readonly deps: WalletGateDeps;
  private readonly clock: () => Date;
  private readonly lock: SpendLock;

  constructor(deps: WalletGateDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => new Date());
    this.lock = deps.lock ?? new SpendLock();
  }

  /**
   * Run one spend intent through the full gate sequence. Never throws for
   * policy, confirmation or backend outcomes — those are typed
   * `GateOutcome`s; an exception escaping here means the ledger itself
   * failed after money may have moved (fail closed, operator attention).
   */
  async execute(intent: SpendIntent): Promise<GateOutcome> {
    // 1. In-process mutex, non-blocking: a spend (possibly waiting on a
    // human) is in flight, so this one is refused rather than queued —
    // queued intents would execute against a world the caller no longer
    // sees. Not audited: contention is transient, not a policy event.
    if (!this.lock.tryAcquire()) {
      return {
        status: "denied",
        requestId: intent.requestId,
        reasonCode: "spend-in-flight",
        humanText: "Another money operation is already in flight. Retry after it settles.",
      };
    }
    try {
      return await this.run(intent);
    } finally {
      this.lock.release();
    }
  }

  private async run(intent: SpendIntent): Promise<GateOutcome> {
    const { ledger, backend, confirmer, audit, stateDir } = this.deps;

    // 2. Idempotency: a known requestId NEVER causes a second spend — the
    // caller gets the recorded outcome of the first attempt.
    const prior = ledger.getOutcome(intent.requestId);
    if (prior !== null) {
      return { status: "replayed", requestId: intent.requestId, snapshot: prior };
    }

    // 3. Freshness: reload policy (cheap stat, full reload on change) and
    // read the operator state. Any failure denies — a wallet that cannot
    // read its rules must not guess them.
    let loaded: LoadedPolicy;
    let state: WalletState;
    try {
      const refreshed = this.deps.policySource.refresh();
      if (refreshed.changed) {
        audit.write({
          event: "policy-reload",
          oldHash: refreshed.previousHash,
          newHash: refreshed.policy.policyHash,
        });
      }
      loaded = refreshed.policy;
      state = readState(stateDir);
    } catch (error) {
      return this.deny(
        intent,
        "policy-unreadable",
        `The policy or wallet state could not be loaded; every spend is denied until a ` +
          `human fixes it: ${errorDetail(error)}`,
      );
    }

    // 4. Defensive re-validation against the CURRENT policy lists.
    if (!recipientListed(intent, loaded.policy)) {
      return this.deny(
        intent,
        "recipient-not-listed",
        `"${intent.recipientName}" (${intent.recipientAddress}) is not on the current ` +
          `${intent.kind === "topup" ? "facilitator" : "recipient"} allowlist.`,
      );
    }

    // 5. Policy evaluation. A deny leaves NO ledger trace — nothing was
    // reserved, nothing counts against the caps.
    let decision = evaluatePolicy(intent, loaded.policy, ledger, state, this.clock());
    if (decision.verdict === "deny") {
      return this.deny(intent, decision.reasonCode, decision.humanText);
    }

    let humanConfirmed = false;
    if (decision.verdict === "confirm") {
      // 6. Human confirmation. No channel ⇒ fail-closed deny, never a
      // silent auto-approve.
      if (!confirmer.available()) {
        return this.deny(
          intent,
          "no-elicitation",
          "This spend needs a human confirmation, but the connected host does not " +
            "support MCP elicitation. Use a host that does (e.g. Claude Code >= 2.1.76), " +
            "or have the operator adjust the allowlist via the peculium CLI.",
        );
      }
      const caps = loaded.policy.currencies.find((entry) => entry.currency === intent.currency);
      if (caps === undefined) {
        // The engine just passed this intent, so the entry exists; keep
        // the lookup honest instead of asserting.
        return this.deny(
          intent,
          "currency-not-configured",
          `Currency ${intent.currency} has no cap entry in the policy and is not spendable.`,
        );
      }
      audit.write({ event: "confirm-requested", requestId: intent.requestId });
      const message = renderConfirmMessage(intent, {
        policy: loaded.policy,
        spentInWindowSats: ledger.spentInWindowSats(intent.currency, DAY_MS, this.clock()),
        currencyCaps: { maxPerDaySats: caps.maxPerDaySats },
        confirmReason: decision.reason,
      });
      const outcome = await confirmer.confirm(
        message,
        loaded.policy.confirmTimeoutSeconds * 1000,
      );
      if (outcome === "denied") {
        audit.write({ event: "confirm-declined", requestId: intent.requestId });
        return {
          status: "denied",
          requestId: intent.requestId,
          reasonCode: "human-declined",
          humanText: "The human declined this spend.",
        };
      }
      if (outcome !== "approved") {
        // "timeout" and "unavailable" (channel vanished mid-request) both
        // mean nobody approved within the window — fail closed.
        audit.write({ event: "confirm-timeout", requestId: intent.requestId });
        return {
          status: "denied",
          requestId: intent.requestId,
          reasonCode: "confirm-timeout",
          humanText: "No confirmation arrived before the timeout; the spend was not executed.",
        };
      }
      audit.write({ event: "confirm-approved", requestId: intent.requestId });
      humanConfirmed = true;

      // 7. Re-evaluate with fresh policy, state and clock: the human
      // paused the world — arm windows, grants, caps and the policy file
      // itself may all have moved while the dialog was open.
      try {
        const refreshed = this.deps.policySource.refresh();
        if (refreshed.changed) {
          audit.write({
            event: "policy-reload",
            oldHash: refreshed.previousHash,
            newHash: refreshed.policy.policyHash,
          });
        }
        loaded = refreshed.policy;
        state = readState(stateDir);
      } catch (error) {
        return this.deny(
          intent,
          "policy-unreadable",
          `The policy or wallet state could not be reloaded after confirmation: ` +
            `${errorDetail(error)}`,
        );
      }
      if (!recipientListed(intent, loaded.policy)) {
        return this.deny(
          intent,
          "recipient-not-listed",
          `"${intent.recipientName}" (${intent.recipientAddress}) is no longer on the ` +
            `current allowlist.`,
        );
      }
      decision = evaluatePolicy(intent, loaded.policy, ledger, state, this.clock());
      if (decision.verdict === "deny") {
        return this.deny(intent, decision.reasonCode, decision.humanText);
      }
      // A repeated "confirm" verdict is satisfied by the approval above.
    }

    // 8. Reserve: the pending row is durable BEFORE any execution. A
    // reservation that cannot be written means no spend at all.
    const approval: SpendApproval = humanConfirmed ? "human-confirmed" : "auto";
    try {
      ledger.recordPending(intent, approval, loaded.policyHash);
    } catch (error) {
      return {
        status: "denied",
        requestId: intent.requestId,
        reasonCode: "ledger-unwritable",
        humanText:
          `The spend ledger could not record the reservation, so nothing was sent: ` +
          `${errorDetail(error)}`,
      };
    }

    // 9. Execute. The outpoint discipline rides along: never re-spend an
    // in-flight input, and only CLEAN unconfirmed change is spendable.
    let receipt: SpendReceipt;
    try {
      receipt = await backend.executeSpend({
        fromAddress: loaded.policy.agentAddress,
        toAddress: intent.recipientAddress,
        amountSats: intent.amountSats,
        currency: intent.currency,
        excludeOutpoints: ledger.spentOutpointsInFlight(),
        spendableUnconfirmedChange: ledger.pendingChangeOutpoints(),
      });
    } catch (error) {
      if (error instanceof SpendRejectedError) {
        // Proven no-op — the reservation is released.
        ledger.recordFailed(intent.requestId, error.stage, error.detail);
        return {
          status: "failed",
          requestId: intent.requestId,
          stage: error.stage,
          humanText: `The spend failed definitively (${error.stage}) and did not move ` +
            `money: ${error.message}`,
        };
      }
      // SpendUncertainError — and ANY unexpected throw: we cannot prove
      // the bytes never left, so the amount stays reserved (fail closed).
      ledger.recordAmbiguous(intent.requestId, "broadcast-transport-error");
      return {
        status: "ambiguous",
        requestId: intent.requestId,
        humanText:
          `The broadcast may or may not have reached the network ` +
          `(${errorDetail(error)}). The amount stays reserved against the caps until ` +
          `the reconciler or \`peculium resolve\` settles it.`,
      };
    }

    // 10. The money moved: record the txid and outpoints.
    ledger.recordBroadcast(
      intent.requestId,
      receipt.txid,
      receipt.spentOutpoints,
      receipt.changeOutpoint,
    );

    // 11. Grant depletion — best effort AFTER the spend. A state-write
    // failure must not turn a real spend into an error; warn and move on
    // (the ledger, not the grant remainder, is the money record).
    try {
      const fresh = readState(stateDir);
      const depleted = depleteGrant(fresh, intent.currency, intent.amountSats);
      if (depleted !== fresh) {
        writeState(stateDir, depleted);
      }
    } catch (error) {
      process.stderr.write(
        `peculium: grant depletion failed after committed spend ` +
          `${intent.requestId} (the spend itself succeeded): ${errorDetail(error)}\n`,
      );
    }

    return { status: "committed", requestId: intent.requestId, txid: receipt.txid };
  }

  /** Audit an `intent-denied` line and build the matching deny outcome. */
  private deny(intent: SpendIntent, reasonCode: GateDenyCode, humanText: string): GateOutcome {
    this.deps.audit.write({
      event: "intent-denied",
      requestId: intent.requestId,
      reasonCode,
      kind: intent.kind,
      recipientName: intent.recipientName,
      currency: intent.currency,
      amountSats: intent.amountSats,
    });
    return { status: "denied", requestId: intent.requestId, reasonCode, humanText };
  }
}
