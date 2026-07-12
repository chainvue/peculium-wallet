/**
 * Ledger record schemas — the rows of the append-only `ledger.jsonl`.
 *
 * The lite state machine (PLAN.md "Architecture (v1, lite)"): a spend is
 * `pending → broadcast(txid) → confirmed(n)`, with `failed` for definitive
 * non-spends, `ambiguous` for transport-uncertain broadcasts and crash
 * recovery, and `resolved` closing an ambiguity. No opids — broadcasting
 * through a public node returns the txid immediately.
 *
 * Every row is JSON-safe by construction: amounts are integer-satoshi
 * strings, timestamps are ISO strings, and every object is strict — an
 * unknown key is a parse error, because a row the code does not fully
 * understand must never be silently half-counted against the caps.
 */

import { z } from "zod";

import { PeculiumError } from "../errors.js";
import { REQUEST_ID_PATTERN } from "../intents.js";

/**
 * A `ledger.jsonl` line did not parse as a known record. The ledger refuses
 * to WRITE a record that fails this schema (a row we cannot replay must
 * never be appended) and refuses to OPEN a file containing one (see
 * `LedgerCorruptError` in ledger.ts for the open-time wrapper).
 */
export class LedgerRecordError extends PeculiumError {
  constructor(message: string) {
    super("ledger-record", message);
    this.name = "LedgerRecordError";
  }
}

const requestIdSchema = z
  .string()
  .regex(REQUEST_ID_PATTERN, "requestId must be 8-64 characters of [A-Za-z0-9._-]");

const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** sha256 hex — intent fingerprints and policy hashes share the format. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

const txidSchema = z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-hex txid");

/** An outpoint reference in canonical `txid:vout` form. */
const outpointSchema = z
  .string()
  .regex(/^[0-9a-f]{64}:(0|[1-9]\d*)$/, 'must be an outpoint in "txid:vout" form');

const satsStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be a non-negative integer satoshi string");

/**
 * The reservation row — written and fsynced BEFORE any bytes go near the
 * network (RISKS.md crash semantics). Carries everything the aggregates
 * and the audit trail need; its `at` is THE timestamp for all rolling
 * windows, regardless of when the request later settles.
 */
export const pendingRecordSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("pending"),
  requestId: requestIdSchema,
  fingerprint: sha256HexSchema,
  kind: z.enum(["topup", "send"]),
  recipientAddress: z.string().min(1),
  recipientName: z.string().min(1),
  currency: z.string().min(1),
  amountSats: satsStringSchema,
  approval: z.enum(["auto", "human-confirmed"]),
  policyHash: z.string().min(1),
  at: isoDateTimeSchema,
});

/**
 * The node accepted `sendrawtransaction`. `spentOutpoints` are the inputs
 * this tx consumed (excluded from UTXO selection while in flight) and
 * `changeOutpoint` is our own change output, if any (spendable-from-
 * unconfirmed by E3, flagged in status).
 */
export const broadcastRecordSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("broadcast"),
  requestId: requestIdSchema,
  txid: txidSchema,
  spentOutpoints: z.array(outpointSchema),
  changeOutpoint: outpointSchema.nullable(),
  at: isoDateTimeSchema,
});

/**
 * Confirmation progress via `getrawtransaction`. May repeat for the same
 * request with strictly increasing counts; `confirmations` is at least 1 —
 * a zero-confirmation tx is still just "broadcast".
 */
export const confirmedRecordSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("confirmed"),
  requestId: requestIdSchema,
  txid: txidSchema,
  confirmations: z.number().int().min(1),
  at: isoDateTimeSchema,
});

/**
 * A DEFINITIVE non-spend: the tx never left the process ("build") or the
 * node rejected it outright ("broadcast-rejected"). Only these certainties
 * may be `failed`; a transport error after the bytes were sent is
 * `ambiguous`, never `failed` (fail closed).
 */
export const failedRecordSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("failed"),
  requestId: requestIdSchema,
  stage: z.enum(["build", "broadcast-rejected"]),
  error: z.strictObject({
    code: z.number().int().optional(),
    message: z.string().min(1),
  }),
  at: isoDateTimeSchema,
});

/**
 * We cannot know whether money moved: the broadcast transport failed after
 * the request may have left the machine, or the process crashed between
 * `pending` and `broadcast`. Counts as spent until `resolved`.
 */
export const ambiguousRecordSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("ambiguous"),
  requestId: requestIdSchema,
  cause: z.enum(["broadcast-transport-error", "crash-recovery"]),
  at: isoDateTimeSchema,
});

/**
 * Closes an ambiguity: E3's reconciler (via `getrawtransaction`) or the
 * human (`peculium resolve`) determined whether the tx exists on-chain.
 */
export const resolvedRecordSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("resolved"),
  requestId: requestIdSchema,
  outcome: z.enum(["spent", "not-spent"]),
  txid: txidSchema.nullable(),
  by: z.enum(["reconciler", "cli-resolve"]),
  at: isoDateTimeSchema,
});

export const ledgerRecordSchema = z.discriminatedUnion("type", [
  pendingRecordSchema,
  broadcastRecordSchema,
  confirmedRecordSchema,
  failedRecordSchema,
  ambiguousRecordSchema,
  resolvedRecordSchema,
]);

export type PendingRecord = z.infer<typeof pendingRecordSchema>;
export type BroadcastRecord = z.infer<typeof broadcastRecordSchema>;
export type ConfirmedRecord = z.infer<typeof confirmedRecordSchema>;
export type FailedRecord = z.infer<typeof failedRecordSchema>;
export type AmbiguousRecord = z.infer<typeof ambiguousRecordSchema>;
export type ResolvedRecord = z.infer<typeof resolvedRecordSchema>;
export type LedgerRecord = z.infer<typeof ledgerRecordSchema>;

/** How a pending spend was approved (policy tier, engine.ts). */
export type SpendApproval = PendingRecord["approval"];
/** Where a definitive failure happened. */
export type FailureStage = FailedRecord["stage"];
/** The failure detail carried by a `failed` row. */
export type FailureDetail = FailedRecord["error"];
/** Why a request became ambiguous. */
export type AmbiguousCause = AmbiguousRecord["cause"];
/** How an ambiguity was closed. */
export type ResolvedOutcome = ResolvedRecord["outcome"];
/** Who closed the ambiguity. */
export type ResolvedBy = ResolvedRecord["by"];

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Parse one `ledger.jsonl` line into a typed record. Throws
 * `LedgerRecordError` on anything that is not exactly one known row —
 * there is no lenient mode, because a misread ledger miscounts money.
 */
export function parseLedgerLine(line: string): LedgerRecord {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LedgerRecordError(`ledger line is not valid JSON: ${detail}`);
  }
  const result = ledgerRecordSchema.safeParse(json);
  if (!result.success) {
    throw new LedgerRecordError(`ledger line is not a known record: ${formatIssues(result.error)}`);
  }
  return result.data;
}
