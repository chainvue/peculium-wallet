/**
 * The confirmation boundary — where a human approves or refuses a spend.
 *
 * The gate talks to the `Confirmer` INTERFACE only. The real MCP
 * elicitation confirmer arrives in E4; this module ships the contract, the
 * message renderer and a scriptable test/dev implementation.
 *
 * The confirmation MESSAGE is a security surface: it is built exclusively
 * from the validated intent (whose recipient pair the gate re-resolved
 * against the CURRENT policy) and from policy entries — never from agent
 * free text, so a prompt-injected "reason" can never dress up a spend as
 * something else. Rendering is deterministic and clock-free.
 */

import { formatAmount } from "verus-rpc";

import type { SpendIntent } from "./intents.js";
import type { Policy } from "./policy/schema.js";

/**
 * How a confirmation round ended. "unavailable" means the channel went
 * away mid-request (e.g. the host dropped the elicitation) — the gate
 * treats everything except "approved" as a refusal (fail closed).
 */
export type ConfirmOutcome = "approved" | "denied" | "timeout" | "unavailable";

/** The gate's view of a confirmation channel. */
export interface Confirmer {
  /** Whether a human can be asked at all (e.g. host supports elicitation). */
  available(): boolean;
  /** Present `message` and wait up to `timeoutMs` for the human's verdict. */
  confirm(message: string, timeoutMs: number): Promise<ConfirmOutcome>;
}

/** Everything the renderer may draw on beside the intent itself. */
export interface ConfirmContext {
  policy: Policy;
  /** Sats already counted against the currency's trailing-24h window. */
  spentInWindowSats: bigint;
  /** The policy cap the day-usage line is measured against. */
  currencyCaps: { maxPerDaySats: bigint };
  /** The engine's confirm reason (a fixed code, never agent text). */
  confirmReason: string;
}

/**
 * Render the human-facing confirmation message. Multi-line, deterministic,
 * built ONLY from the validated intent and policy-derived context — see
 * the module doc for why no other input is allowed.
 */
export function renderConfirmMessage(intent: SpendIntent, context: ConfirmContext): string {
  const action =
    intent.kind === "topup"
      ? "Top up a facilitator balance (topup)"
      : "Send funds to a recipient (send)";
  const afterSpendSats = context.spentInWindowSats + intent.amountSats;
  return [
    "Peculium payment confirmation",
    `Action: ${action}`,
    `Amount: ${formatAmount(intent.amountSats)} ${intent.currency}`,
    `Recipient: ${intent.recipientName} (${intent.recipientAddress})`,
    `Why confirmation is needed: ${context.confirmReason}`,
    `24h usage after this spend: ${formatAmount(afterSpendSats)} of ` +
      `${formatAmount(context.currencyCaps.maxPerDaySats)} ${intent.currency}`,
    `Network: ${context.policy.network}`,
    "Approving moves real funds immediately and cannot be undone. " +
      "Approve only if you expect this exact payment.",
  ].join("\n");
}

/**
 * Test/dev confirmer with a fixed outcome. Records every request it
 * receives; an optional `onConfirm` hook runs before the outcome resolves
 * (tests use it to move a scripted clock during the "human pause").
 */
export class StaticConfirmer implements Confirmer {
  /** Every confirm() call this instance received, in order. */
  readonly received: { message: string; timeoutMs: number }[] = [];

  private readonly outcome: ConfirmOutcome;
  private readonly availability: boolean;
  private readonly onConfirm: (() => void | Promise<void>) | null;

  constructor(
    outcome: ConfirmOutcome,
    opts: { available?: boolean; onConfirm?: () => void | Promise<void> } = {},
  ) {
    this.outcome = outcome;
    this.availability = opts.available ?? true;
    this.onConfirm = opts.onConfirm ?? null;
  }

  available(): boolean {
    return this.availability;
  }

  async confirm(message: string, timeoutMs: number): Promise<ConfirmOutcome> {
    this.received.push({ message, timeoutMs });
    if (this.onConfirm !== null) {
      await this.onConfirm();
    }
    return this.outcome;
  }
}
