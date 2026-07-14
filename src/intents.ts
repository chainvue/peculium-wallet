/**
 * Typed spend intents — the only shape a money request may take past the
 * MCP boundary (DESIGN.md §0: the LLM is untrusted input). The MCP layer
 * validates raw tool input with the schemas below, resolves the recipient
 * *name* against the policy allowlists, and only then builds a
 * `SpendIntent` carrying the resolved address. The policy engine
 * re-validates the result — agent free text never reaches the engine.
 */

import { createHash } from "node:crypto";
import { parseAmount } from "@chainvue/verus-rpc";
import { z } from "zod";

/**
 * requestId is the caller-chosen idempotency key (layer one of the
 * two-layer idempotency design, DESIGN.md T7). Constrained to a small
 * URL-safe alphabet so it can appear verbatim in ledger rows, audit lines
 * and error messages without escaping questions.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

interface SpendIntentBase {
  /** Caller-chosen idempotency key; must match {@link REQUEST_ID_PATTERN}. */
  requestId: string;
  /** Exact amount in satoshis; always > 0 (the engine re-checks). */
  amountSats: bigint;
  /** Currency the amount is denominated in ("VRSCTEST" or a PBaaS token). */
  currency: string;
  /** Allowlisted destination, resolved by the gate — never agent free text. */
  recipientAddress: string;
  /** The allowlist name the address was resolved from (confirm prompts, audit). */
  recipientName: string;
}

/** Fund a v402 balance at an allowlisted facilitator (may auto-approve). */
export interface TopupIntent extends SpendIntentBase {
  kind: "topup";
}

/** Send to an allowlisted recipient (always requires human confirmation). */
export interface SendIntent extends SpendIntentBase {
  kind: "send";
}

export type SpendIntent = TopupIntent | SendIntent;

/**
 * An OFF-CHAIN v402 per-request payment (`wallet_paid_fetch`): a signature
 * against PREPAID credit, not a blockchain transaction. Reuses the base
 * shape so the ledger records it uniformly: `recipientName` is the
 * allowlist SERVICE name, `recipientAddress` its normalized origin,
 * `amountSats`/`currency` are the 402 offer's price — vetted by the engine
 * BEFORE any signature exists. The offer fields ride along so the pure
 * engine can pin them against the policy (network, currency, domain,
 * facilitator) without doing any IO itself.
 */
export interface PaidFetchIntent extends SpendIntentBase {
  kind: "paid-fetch";
  /** Uppercase HTTP method of the guarded call. */
  method: string;
  /** Request-target (path + query) — validated input, appended to the origin. */
  path: string;
  /** `network` advertised by the 402 offer (must equal the policy network). */
  offerNetwork: string;
  /** `payTo` identity of the offer (recorded for audit; not a policy input). */
  payTo: string;
  /** Facilitator base URL advertised by the offer (pinned to the allowlist). */
  offerFacilitator: string;
  /** `canonicalDomain` the payment signature would bind (pinned to the origin). */
  canonicalDomain: string;
}

/** Everything the ledger records: on-chain spends plus off-chain payments. */
export type MoneyIntent = SpendIntent | PaidFetchIntent;

/**
 * Canonical dedupe fingerprint (layer two of idempotency): sha256 hex over
 * kind, resolved address, currency and the exact satoshi amount — and
 * NOTHING else. `requestId` and display names are deliberately excluded:
 * free text must never decide whether two money movements count as "the
 * same", otherwise a retry loop could sidestep the dedupe window by
 * varying a label while repeating the identical transfer.
 */
export function intentFingerprint(intent: MoneyIntent): string {
  const canonical = `${intent.kind}\n${intent.recipientAddress}\n${intent.currency}\n${intent.amountSats}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Raw-input schema for `requestId` (reused by the MCP tool definitions). */
export const requestIdSchema = z
  .string()
  .regex(REQUEST_ID_PATTERN, "requestId must be 8-64 characters of [A-Za-z0-9._-]");

/**
 * Raw-input schema for a decimal amount string ("0.5", "10"). Validation
 * delegates to verus-rpc `parseAmount` — the single authority on the
 * 8-decimal grammar — and additionally requires a strictly positive value.
 * Kept as a string here; conversion to satoshis happens where the value is
 * consumed, so no float ever exists in between.
 */
export const amountStringSchema = z.string().superRefine((value, ctx) => {
  let sats: bigint;
  try {
    sats = parseAmount(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "not a decimal amount",
    });
    return;
  }
  if (sats <= 0n) {
    ctx.addIssue({ code: "custom", message: `amount must be positive: ${value}` });
  }
});

/**
 * Raw tool input shared by the money tools (`wallet_topup_facilitator`,
 * `wallet_send`, `wallet_precheck`). Strict and JSON-safe: the agent names
 * a recipient, it never supplies an address.
 */
export const rawSpendInputSchema = z.strictObject({
  requestId: requestIdSchema,
  amount: amountStringSchema,
  currency: z.string().min(1),
  recipient: z.string().min(1),
});

export type RawSpendInput = z.infer<typeof rawSpendInputSchema>;
