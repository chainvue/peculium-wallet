/**
 * The execution boundary — where an approved, ledgered spend becomes bytes
 * on the network.
 *
 * The gate talks to the `WalletBackend` INTERFACE only. The v1 `LiteBackend`
 * (UTXO fetch → offline build/sign → `sendrawtransaction`) lands in E3b once
 * the SDK's live-proof harness passes (RISKS.md gates it); the interface is
 * also the v2 signer-daemon seam — a backend implementation may live in a
 * separate process holding the key.
 *
 * The error split IS the money semantics: `SpendRejectedError` is a proven
 * no-op (safe to release the reservation), `SpendUncertainError` means the
 * broadcast MAY have reached the network (stays reserved as `ambiguous`).
 * A backend must never map a post-send transport failure to "rejected".
 */

import { PeculiumError } from "./errors.js";
import type { FailureDetail, FailureStage } from "./ledger/records.js";

/** One fully specified spend, handed to the backend AFTER ledger reservation. */
export interface SpendInstruction {
  /** The agent's own funding address (policy `agentAddress`). */
  fromAddress: string;
  /** The allowlisted destination, resolved and re-validated by the gate. */
  toAddress: string;
  /** Exact amount in satoshis. */
  amountSats: bigint;
  /** Currency the amount is denominated in. */
  currency: string;
  /** Outpoints of in-flight txs — MUST be excluded from UTXO selection. */
  excludeOutpoints: readonly string[];
  /** Own unconfirmed change outpoints the backend MAY spend from. */
  spendableUnconfirmedChange: readonly string[];
}

/** What a successful broadcast returns (txid arrives synchronously — lite). */
export interface SpendReceipt {
  txid: string;
  /** The inputs this tx consumed (`txid:vout` form). */
  spentOutpoints: string[];
  /** Our own change output of this tx, if any. */
  changeOutpoint: string | null;
}

/** The gate's view of tx execution. Implementations: MockBackend (tests), LiteBackend (E3b). */
export interface WalletBackend {
  executeSpend(instruction: SpendInstruction): Promise<SpendReceipt>;
}

/**
 * A DEFINITE no-op: the tx never left the process ("build") or the node
 * rejected it outright ("broadcast-rejected"). Carries the ledger-shaped
 * failure detail so the gate can record it verbatim.
 */
export class SpendRejectedError extends PeculiumError {
  readonly stage: FailureStage;
  readonly detail: FailureDetail;

  constructor(stage: FailureStage, message: string, rpcCode?: number) {
    super("spend-rejected", message);
    this.name = "SpendRejectedError";
    this.stage = stage;
    this.detail = rpcCode === undefined ? { message } : { code: rpcCode, message };
  }
}

/**
 * The broadcast MAY have reached the network: the transport failed after
 * the send started, so "did money move?" is unanswerable here. The gate
 * records `ambiguous` — the amount stays reserved until resolution.
 */
export class SpendUncertainError extends PeculiumError {
  constructor(message: string) {
    super("spend-uncertain", message);
    this.name = "SpendUncertainError";
  }
}

/** One scripted MockBackend behavior, consumed per call in FIFO order. */
type MockPlan =
  | { kind: "succeed"; receipt: SpendReceipt }
  | { kind: "throw"; error: Error };

/**
 * Scriptable in-memory backend for tests and the E4 wiring. Script each
 * call up front (`willSucceed` / `willReject` / `willBeUncertain` /
 * `willThrow`); an unscripted call throws a plain Error, which the gate
 * treats as uncertain — a test that did not expect a spend fails loudly
 * either way. Records every instruction; `onExecute` lets a test observe
 * surrounding state (e.g. the ledger) at the moment of execution.
 */
export class MockBackend implements WalletBackend {
  /** Every instruction received, in call order. */
  readonly instructions: SpendInstruction[] = [];

  private readonly plans: MockPlan[] = [];
  private readonly onExecute: ((instruction: SpendInstruction) => void) | null;

  constructor(opts: { onExecute?: (instruction: SpendInstruction) => void } = {}) {
    this.onExecute = opts.onExecute ?? null;
  }

  /** Script the next call to succeed with `receipt`. */
  willSucceed(receipt: SpendReceipt): this {
    this.plans.push({ kind: "succeed", receipt });
    return this;
  }

  /** Script the next call to throw a definite {@link SpendRejectedError}. */
  willReject(stage: FailureStage, message: string, rpcCode?: number): this {
    this.plans.push({ kind: "throw", error: new SpendRejectedError(stage, message, rpcCode) });
    return this;
  }

  /** Script the next call to throw a {@link SpendUncertainError}. */
  willBeUncertain(message: string): this {
    this.plans.push({ kind: "throw", error: new SpendUncertainError(message) });
    return this;
  }

  /** Script the next call to throw an arbitrary (unexpected) error. */
  willThrow(error: Error): this {
    this.plans.push({ kind: "throw", error });
    return this;
  }

  executeSpend(instruction: SpendInstruction): Promise<SpendReceipt> {
    this.instructions.push(instruction);
    this.onExecute?.(instruction);
    const plan = this.plans.shift();
    if (plan === undefined) {
      return Promise.reject(new Error("MockBackend: no scripted behavior left for this call"));
    }
    return plan.kind === "succeed" ? Promise.resolve(plan.receipt) : Promise.reject(plan.error);
  }
}
