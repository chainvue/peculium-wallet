/**
 * The audit trail — `audit.jsonl`, best-effort and append-only.
 *
 * The hard rule (PLAN.md): audit must NEVER block or unblock money. Every
 * write is fire-and-forget — the first IO failure earns one stderr warning
 * per AuditLog instance, after that failures are silent. The LEDGER is the
 * money record; this file is the operator-facing narrative around it
 * (denials, confirmations, policy changes, recoveries), input to
 * `peculium history`.
 *
 * Rotation keeps the file bounded: past `maxBytes` it is renamed to
 * `audit.jsonl.1` (replacing any previous one) and a fresh file starts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

const AUDIT_FILE = "audit.jsonl";
const ROTATED_FILE = "audit.jsonl.1";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const isoDateTimeSchema = z.iso.datetime({ offset: true });

const baseFields = {
  v: z.literal(1),
  at: isoDateTimeSchema,
} as const;

const requestIdField = z.string().min(1);

type ConfirmEventName =
  | "confirm-requested"
  | "confirm-approved"
  | "confirm-declined"
  | "confirm-timeout";

/** The serialized `audit.jsonl` line shape (strict, JSON-safe). */
export const auditLineSchema = z.discriminatedUnion("event", [
  z.strictObject({
    ...baseFields,
    event: z.literal("intent-denied"),
    requestId: requestIdField,
    reasonCode: z.string().min(1),
    kind: z.enum(["topup", "send"]),
    recipientName: z.string().min(1),
    currency: z.string().min(1),
    amountSats: z.string().regex(/^(0|[1-9]\d*)$/, "must be an integer satoshi string"),
  }),
  z.strictObject({ ...baseFields, event: z.literal("confirm-requested"), requestId: requestIdField }),
  z.strictObject({ ...baseFields, event: z.literal("confirm-approved"), requestId: requestIdField }),
  z.strictObject({ ...baseFields, event: z.literal("confirm-declined"), requestId: requestIdField }),
  z.strictObject({ ...baseFields, event: z.literal("confirm-timeout"), requestId: requestIdField }),
  z.strictObject({
    ...baseFields,
    event: z.literal("policy-changed"),
    oldHash: z.string().min(1),
    newHash: z.string().min(1),
    command: z.string().min(1),
  }),
  z.strictObject({
    ...baseFields,
    event: z.literal("policy-reload"),
    oldHash: z.string().min(1),
    newHash: z.string().min(1),
  }),
  z.strictObject({ ...baseFields, event: z.literal("server-start") }),
  z.strictObject({ ...baseFields, event: z.literal("server-stop") }),
  z.strictObject({
    ...baseFields,
    event: z.literal("ledger-recovery"),
    requestId: requestIdField,
    action: z.string().min(1),
  }),
]);

export type AuditLine = z.infer<typeof auditLineSchema>;

/**
 * The typed events callers pass to {@link AuditLog.write}. Runtime-shaped
 * (bigint satoshis); serialization to the JSON-safe line happens inside
 * `write`. `reasonCode` is a string on purpose: the gate audits its own
 * deny codes ("policy-unreadable", "no-elicitation") through the same
 * event as the engine's `DenyCode`s.
 */
export type AuditEvent =
  | {
      event: "intent-denied";
      requestId: string;
      reasonCode: string;
      kind: "topup" | "send";
      recipientName: string;
      currency: string;
      amountSats: bigint;
    }
  | { event: ConfirmEventName; requestId: string }
  | { event: "policy-changed"; oldHash: string; newHash: string; command: string }
  | { event: "policy-reload"; oldHash: string; newHash: string }
  | { event: "server-start" }
  | { event: "server-stop" }
  | { event: "ledger-recovery"; requestId: string; action: string };

/**
 * Best-effort append-only audit log. Construct via {@link AuditLog.open};
 * neither open nor write ever throws — a wallet that cannot audit still
 * moves (and still refuses) money exactly as before.
 */
export class AuditLog {
  private readonly filePath: string;
  private readonly rotatedPath: string;
  private readonly clock: () => Date;
  private readonly maxBytes: number;
  private fd: number | null = null;
  private size = 0;
  private warned = false;

  private constructor(dir: string, opts: { clock?: () => Date; maxBytes?: number }) {
    this.filePath = path.join(dir, AUDIT_FILE);
    this.rotatedPath = path.join(dir, ROTATED_FILE);
    this.clock = opts.clock ?? (() => new Date());
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Open (creating if missing) `audit.jsonl` in `dir`. Never throws: on
   * failure it warns once on stderr and returns a disabled instance whose
   * writes are no-ops.
   */
  static open(dir: string, opts: { clock?: () => Date; maxBytes?: number } = {}): AuditLog {
    const log = new AuditLog(dir, opts);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      log.fd = fs.openSync(log.filePath, "a", 0o600);
      log.size = fs.fstatSync(log.fd).size;
    } catch (error) {
      log.warnOnce(error);
    }
    return log;
  }

  /**
   * Append one event, fire-and-forget: validate, rotate if the file would
   * exceed `maxBytes`, write. Any failure is swallowed (one stderr warning
   * per instance) — audit IO must never block money.
   */
  write(event: AuditEvent): void {
    try {
      if (this.fd === null) {
        return;
      }
      const line = auditLineSchema.parse(this.toLine(event));
      const payload = `${JSON.stringify(line)}\n`;
      const bytes = Buffer.byteLength(payload, "utf8");
      if (this.size + bytes > this.maxBytes) {
        this.rotate();
      }
      fs.writeSync(this.fd, payload);
      this.size += bytes;
    } catch (error) {
      this.warnOnce(error);
    }
  }

  /** Close the fd (best-effort; further writes become no-ops). */
  close(): void {
    if (this.fd === null) {
      return;
    }
    try {
      fs.closeSync(this.fd);
    } catch (error) {
      this.warnOnce(error);
    }
    this.fd = null;
  }

  /** Convert a runtime event to the JSON-safe line shape. */
  private toLine(event: AuditEvent): unknown {
    const base = { v: 1, at: this.clock().toISOString() };
    if (event.event === "intent-denied") {
      return { ...base, ...event, amountSats: event.amountSats.toString() };
    }
    return { ...base, ...event };
  }

  /**
   * Rename the full file to `audit.jsonl.1` (replacing any previous one)
   * and start fresh. If rotation fails midway the instance disables itself
   * rather than risking interleaved writes on a stale fd.
   */
  private rotate(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    fs.renameSync(this.filePath, this.rotatedPath);
    this.fd = fs.openSync(this.filePath, "a", 0o600);
    this.size = 0;
  }

  private warnOnce(error: unknown): void {
    if (this.warned) {
      return;
    }
    this.warned = true;
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`peculium: audit trail degraded (writes are best-effort): ${detail}\n`);
  }
}
