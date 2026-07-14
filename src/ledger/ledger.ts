/**
 * The append-only spend ledger — Peculium's money memory.
 *
 * One `ledger.jsonl` per config dir, guarded by a pid lock. Every append is
 * a single `writeSync` + `fsyncSync` of one JSON line on a persistently
 * open fd; the in-memory index is updated only AFTER the bytes are durable,
 * so what the engine counts is never ahead of what a crash would replay.
 *
 * Crash semantics (RISKS.md, decided): the `pending` row is written and
 * fsynced BEFORE any broadcast. A request whose last record is `pending`
 * at startup becomes `ambiguous(crash-recovery)` — we cannot know whether
 * the bytes hit the network. The fail-closed counting rule everywhere:
 * a request COUNTS as spent unless its terminal record is `failed` or
 * `resolved(not-spent)`. Rolling windows are timed by the PENDING row's
 * `at`, and the window edge is inclusive (a row exactly `window` old still
 * counts — when in doubt, count it against the caps).
 *
 * A torn or unparsable line ANYWHERE makes `open` refuse (fail closed, no
 * silent skips); `peculium resolve --repair-tail` is the human escape
 * hatch for the torn-tail case.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { PeculiumError } from "../errors.js";
import { intentFingerprint, type MoneyIntent } from "../intents.js";
import type { LedgerView } from "../policy/engine.js";
import {
  ledgerRecordSchema,
  LedgerRecordError,
  parseLedgerLine,
  type AmbiguousCause,
  type BroadcastRecord,
  type FailureDetail,
  type FailureStage,
  type LedgerRecord,
  type PendingRecord,
  type RequestKind,
  type ResolvedBy,
  type ResolvedOutcome,
  type SpendApproval,
} from "./records.js";

const LEDGER_FILE = "ledger.jsonl";
const LOCK_FILE = "ledger.lock";

/**
 * Another live Peculium process holds `ledger.lock`. Two writers on one
 * append-only money log is never safe, so the second open refuses.
 */
export class LedgerLockedError extends PeculiumError {
  constructor(message: string) {
    super("ledger-locked", message);
    this.name = "LedgerLockedError";
  }
}

/**
 * `ledger.jsonl` cannot be trusted: a torn final line, an unparsable line
 * anywhere, or a record sequence the state machine forbids. The wallet
 * refuses to operate — a ledger that miscounts is worse than no wallet.
 */
export class LedgerCorruptError extends PeculiumError {
  constructor(message: string) {
    super("ledger-corrupt", message);
    this.name = "LedgerCorruptError";
  }
}

/**
 * A caller asked for an illegal state transition (or a duplicate pending
 * requestId). Nothing is written: the file only ever contains sequences
 * the state machine accepts, so replay can enforce the same rules.
 */
export class LedgerStateError extends PeculiumError {
  constructor(message: string) {
    super("ledger-state", message);
    this.name = "LedgerStateError";
  }
}

/** The lite state machine's states, named after the last effective record. */
export type RequestState =
  | "pending"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "settled"
  | "ambiguous"
  | "resolved";

/**
 * The current view of one request — everything an idempotent replay
 * (`getOutcome`), `peculium status` or `peculium resolve` needs, flattened
 * with nulls for the stages a request has not reached.
 */
export interface RequestSnapshot {
  requestId: string;
  kind: RequestKind;
  recipientAddress: string;
  recipientName: string;
  currency: string;
  amountSats: bigint;
  approval: SpendApproval;
  policyHash: string;
  /** The pending row's ISO timestamp — the one all windows count by. */
  pendingAt: string;
  state: RequestState;
  /** The txid once known (broadcast onward, or a resolved(spent) txid). */
  txid: string | null;
  /** Highest confirmation count recorded, or null before the first. */
  confirmations: number | null;
  /** Failure detail when state is "failed". */
  failure: { stage: FailureStage; error: FailureDetail } | null;
  /** The HTTP status a paid-fetch settled with, or null (state "settled"). */
  httpStatus: number | null;
  /** Why the request became ambiguous (kept after resolution, for audit). */
  ambiguousCause: AmbiguousCause | null;
  /** How the ambiguity was closed, when state is "resolved". */
  resolution: { outcome: ResolvedOutcome; txid: string | null; by: ResolvedBy } | null;
  /** The fail-closed counting rule applied to this request. */
  countsAsSpent: boolean;
}

/** The mutable per-request index entry built by replay and appends. */
interface RequestTrack {
  pending: PendingRecord;
  pendingAtMs: number;
  amountSats: bigint;
  state: RequestState;
  broadcast: BroadcastRecord | null;
  confirmations: number | null;
  txid: string | null;
  failure: { stage: FailureStage; error: FailureDetail } | null;
  httpStatus: number | null;
  ambiguousCause: AmbiguousCause | null;
  resolution: { outcome: ResolvedOutcome; txid: string | null; by: ResolvedBy } | null;
}

/** True unless `signal 0` proves the pid dead (EPERM means alive, other uid). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire `ledger.lock` by writing our pid with "wx" (atomic create). If
 * the file exists: a live pid refuses; a provably dead pid is taken over;
 * unreadable content refuses (we cannot prove the holder dead — the human
 * removes the file if no peculium process is running).
 */
function acquireLock(lockPath: string): void {
  const payload = `${process.pid}\n`;
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const raw = fs.readFileSync(lockPath, "utf8");
  const holder = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(holder) || holder <= 0 || `${holder}` !== raw.trim()) {
    throw new LedgerLockedError(
      `${lockPath} exists with unreadable content; if no other peculium ` +
        `process is running, delete the file and retry.`,
    );
  }
  if (isProcessAlive(holder)) {
    throw new LedgerLockedError(
      `another peculium process (pid ${holder}) holds the ledger lock at ${lockPath}.`,
    );
  }
  // Stale lock from a dead process — take it over.
  fs.writeFileSync(lockPath, payload, { mode: 0o600 });
}

/** Inclusive trailing-window membership: exactly `windowMs` old still counts. */
function inWindow(atMs: number, windowMs: number, now: Date): boolean {
  return now.getTime() - atMs <= windowMs;
}

/**
 * The spend ledger. Construct via {@link SpendLedger.open}; implements the
 * engine's {@link LedgerView} contract over the replayed index.
 */
export class SpendLedger implements LedgerView {
  /** requestIds that open() recovered from a pending tail (for the audit trail). */
  readonly recoveredRequestIds: readonly string[];

  private readonly tracks = new Map<string, RequestTrack>();
  private readonly clock: () => Date;
  private readonly lockPath: string;
  private fd: number | null;

  private constructor(fd: number, lockPath: string, clock: () => Date) {
    this.fd = fd;
    this.lockPath = lockPath;
    this.clock = clock;
    this.recoveredRequestIds = [];
  }

  /**
   * Open (creating if missing) the ledger in `dir`: acquire the lock,
   * replay `ledger.jsonl` in full, then run crash recovery (every request
   * still `pending` gets an `ambiguous(crash-recovery)` row). Throws
   * `LedgerLockedError` or `LedgerCorruptError` — an unopenable ledger
   * means no spending, by design.
   */
  static open(dir: string, opts: { clock?: () => Date } = {}): SpendLedger {
    const clock = opts.clock ?? (() => new Date());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(dir, LOCK_FILE);
    acquireLock(lockPath);
    let fd: number | null = null;
    try {
      const ledgerPath = path.join(dir, LEDGER_FILE);
      let content = "";
      try {
        content = fs.readFileSync(ledgerPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      fd = fs.openSync(ledgerPath, "a", 0o600);
      const ledger = new SpendLedger(fd, lockPath, clock);
      ledger.replay(content);
      ledger.recoverPendingTails();
      return ledger;
    } catch (error) {
      if (fd !== null) {
        fs.closeSync(fd);
      }
      fs.rmSync(lockPath, { force: true });
      throw error;
    }
  }

  /** Close the fd and release the lock. Idempotent; appends after close throw. */
  close(): void {
    if (this.fd === null) {
      return;
    }
    fs.closeSync(this.fd);
    this.fd = null;
    fs.rmSync(this.lockPath, { force: true });
  }

  // ------------------------------------------------------------------ appends

  /**
   * Reserve a spend: the row that makes the request count against every
   * cap from this instant on, written and fsynced BEFORE any signing or
   * broadcasting. A duplicate requestId throws `LedgerStateError`. For
   * "paid-fetch" intents the pair (recipientName, recipientAddress) is
   * (service name, service origin) and the amount is the vetted offer price.
   */
  recordPending(intent: MoneyIntent, approval: SpendApproval, policyHash: string): PendingRecord {
    return this.append({
      v: 1,
      type: "pending",
      requestId: intent.requestId,
      fingerprint: intentFingerprint(intent),
      kind: intent.kind,
      recipientAddress: intent.recipientAddress,
      recipientName: intent.recipientName,
      currency: intent.currency,
      amountSats: intent.amountSats.toString(),
      approval,
      policyHash,
      at: this.clock().toISOString(),
    });
  }

  /** The node accepted the tx. Legal only from `pending`. */
  recordBroadcast(
    requestId: string,
    txid: string,
    spentOutpoints: string[],
    changeOutpoint: string | null,
  ): BroadcastRecord {
    return this.append({
      v: 1,
      type: "broadcast",
      requestId,
      txid,
      spentOutpoints,
      changeOutpoint,
      at: this.clock().toISOString(),
    });
  }

  /**
   * Confirmation progress. Legal from `broadcast`, and again from
   * `confirmed` with a strictly higher count; the txid must match the
   * broadcast one (a mismatch is an E3 bug, not new information).
   */
  recordConfirmed(requestId: string, txid: string, confirmations: number): LedgerRecord {
    return this.append({
      v: 1,
      type: "confirmed",
      requestId,
      txid,
      confirmations,
      at: this.clock().toISOString(),
    });
  }

  /** A definitive non-spend (terminal; releases the reservation). */
  recordFailed(requestId: string, stage: FailureStage, error: FailureDetail): LedgerRecord {
    return this.append({
      v: 1,
      type: "failed",
      requestId,
      stage,
      error,
      at: this.clock().toISOString(),
    });
  }

  /**
   * A paid-fetch got a definitive HTTP answer after its payment headers
   * were sent (terminal; keeps counting as spent — see records.ts). Legal
   * only from `pending` and only for "paid-fetch" requests.
   */
  recordSettled(requestId: string, httpStatus: number): LedgerRecord {
    return this.append({
      v: 1,
      type: "settled",
      requestId,
      httpStatus,
      at: this.clock().toISOString(),
    });
  }

  /** Outcome unknown — keeps counting as spent until resolved. */
  recordAmbiguous(requestId: string, cause: AmbiguousCause): LedgerRecord {
    return this.append({
      v: 1,
      type: "ambiguous",
      requestId,
      cause,
      at: this.clock().toISOString(),
    });
  }

  /** Close an ambiguity (terminal). `not-spent` releases the reservation. */
  recordResolved(
    requestId: string,
    outcome: ResolvedOutcome,
    txid: string | null,
    by: ResolvedBy,
  ): LedgerRecord {
    return this.append({
      v: 1,
      type: "resolved",
      requestId,
      outcome,
      txid,
      by,
      at: this.clock().toISOString(),
    });
  }

  // ------------------------------------------------------------------ queries

  /** The current state of a request, or null if the requestId is unknown. */
  getOutcome(requestId: string): RequestSnapshot | null {
    const track = this.tracks.get(requestId);
    return track === undefined ? null : this.snapshot(track);
  }

  /**
   * Every request the ledger knows, as snapshots — the data source for
   * spending reports and txid lookups. Unordered; callers sort by
   * `pendingAt`.
   */
  allSnapshots(): RequestSnapshot[] {
    const out: RequestSnapshot[] = [];
    for (const track of this.tracks.values()) {
      out.push(this.snapshot(track));
    }
    return out;
  }

  /** All requests currently stuck at `ambiguous` (for status/resolve). */
  unresolvedAmbiguous(): RequestSnapshot[] {
    const out: RequestSnapshot[] = [];
    for (const track of this.tracks.values()) {
      if (track.state === "ambiguous") {
        out.push(this.snapshot(track));
      }
    }
    return out;
  }

  /**
   * Change outpoints of cleanly in-flight broadcasts (state exactly
   * `broadcast`): the outputs E3 may spend before confirmation. Change of
   * an ambiguous request is deliberately excluded — never build a new tx
   * on an output whose existence is uncertain.
   */
  pendingChangeOutpoints(): string[] {
    const out: string[] = [];
    for (const track of this.tracks.values()) {
      if (track.state === "broadcast" && track.broadcast?.changeOutpoint != null) {
        out.push(track.broadcast.changeOutpoint);
      }
    }
    return out;
  }

  /**
   * Every outpoint consumed by a non-terminal request (`broadcast` or
   * `ambiguous` with a known broadcast). E3 excludes these from UTXO
   * selection so a stale node can never trick us into double-spending our
   * own in-flight inputs.
   */
  spentOutpointsInFlight(): string[] {
    const out = new Set<string>();
    for (const track of this.tracks.values()) {
      if (track.state !== "broadcast" && track.state !== "ambiguous") {
        continue;
      }
      for (const outpoint of track.broadcast?.spentOutpoints ?? []) {
        out.add(outpoint);
      }
    }
    return [...out];
  }

  // ------------------------------------------------------- LedgerView contract
  //
  // The on-chain aggregates exclude "paid-fetch" rows and the paid-fetch
  // aggregates count nothing else (the engine's LedgerView contract):
  // prepaid credit already left the wallet at topup time, so counting a
  // paid-fetch against the wallet-fund caps would double-count it.

  spentInWindowSats(currency: string, windowMs: number, now: Date): bigint {
    let total = 0n;
    for (const track of this.tracks.values()) {
      if (
        track.pending.kind !== "paid-fetch" &&
        track.pending.currency === currency &&
        countsAsSpent(track) &&
        inWindow(track.pendingAtMs, windowMs, now)
      ) {
        total += track.amountSats;
      }
    }
    return total;
  }

  facilitatorSpentInWindowSats(
    address: string,
    currency: string,
    windowMs: number,
    now: Date,
  ): bigint {
    let total = 0n;
    for (const track of this.tracks.values()) {
      if (
        track.pending.kind !== "paid-fetch" &&
        track.pending.recipientAddress === address &&
        track.pending.currency === currency &&
        countsAsSpent(track) &&
        inWindow(track.pendingAtMs, windowMs, now)
      ) {
        total += track.amountSats;
      }
    }
    return total;
  }

  totalSpentSats(currency: string): bigint {
    let total = 0n;
    for (const track of this.tracks.values()) {
      if (
        track.pending.kind !== "paid-fetch" &&
        track.pending.currency === currency &&
        countsAsSpent(track)
      ) {
        total += track.amountSats;
      }
    }
    return total;
  }

  attemptsInWindow(windowMs: number, now: Date): number {
    let count = 0;
    for (const track of this.tracks.values()) {
      if (track.pending.kind !== "paid-fetch" && inWindow(track.pendingAtMs, windowMs, now)) {
        count += 1;
      }
    }
    return count;
  }

  lastAttemptAt(): Date | null {
    let lastMs: number | null = null;
    for (const track of this.tracks.values()) {
      if (track.pending.kind === "paid-fetch") {
        continue;
      }
      if (lastMs === null || track.pendingAtMs > lastMs) {
        lastMs = track.pendingAtMs;
      }
    }
    return lastMs === null ? null : new Date(lastMs);
  }

  paidFetchSpentInWindowSats(currency: string, windowMs: number, now: Date): bigint {
    let total = 0n;
    for (const track of this.tracks.values()) {
      if (
        track.pending.kind === "paid-fetch" &&
        track.pending.currency === currency &&
        countsAsSpent(track) &&
        inWindow(track.pendingAtMs, windowMs, now)
      ) {
        total += track.amountSats;
      }
    }
    return total;
  }

  serviceSpentInWindowSats(
    origin: string,
    currency: string,
    windowMs: number,
    now: Date,
  ): bigint {
    let total = 0n;
    for (const track of this.tracks.values()) {
      if (
        track.pending.kind === "paid-fetch" &&
        track.pending.recipientAddress === origin &&
        track.pending.currency === currency &&
        countsAsSpent(track) &&
        inWindow(track.pendingAtMs, windowMs, now)
      ) {
        total += track.amountSats;
      }
    }
    return total;
  }

  hasFingerprintInWindow(fingerprint: string, windowMs: number, now: Date): boolean {
    for (const track of this.tracks.values()) {
      if (
        track.pending.fingerprint === fingerprint &&
        countsAsSpent(track) &&
        inWindow(track.pendingAtMs, windowMs, now)
      ) {
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ internals

  /**
   * Rebuild the index from the file content. Refuses on: a final line
   * without its terminating newline (torn append — even a clean JSON
   * prefix), an unparsable line anywhere, or a sequence the state machine
   * forbids. Every append writes `JSON + "\n"` in one writeSync and JSON
   * content never contains a raw newline, so "last line lacks \n" detects
   * every torn write exactly.
   */
  private replay(content: string): void {
    if (content === "") {
      return;
    }
    const lines = content.split("\n");
    const tail = lines.pop();
    if (tail !== "") {
      throw new LedgerCorruptError(
        `${LEDGER_FILE} ends in a torn line (crash during append). ` +
          `Run \`peculium resolve --repair-tail\` to inspect and repair the tail.`,
      );
    }
    for (const [index, line] of lines.entries()) {
      let record: LedgerRecord;
      try {
        record = parseLedgerLine(line);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const hint =
          index === lines.length - 1
            ? " Run `peculium resolve --repair-tail` to inspect and repair the tail."
            : " The file needs manual review or restore from backup.";
        throw new LedgerCorruptError(`${LEDGER_FILE} line ${index + 1}: ${detail}.${hint}`);
      }
      const problem = this.transitionProblem(record);
      if (problem !== null) {
        throw new LedgerCorruptError(`${LEDGER_FILE} line ${index + 1}: ${problem}`);
      }
      this.apply(record);
    }
  }

  /**
   * Crash recovery, run once by open(): a request whose last record is
   * `pending` crashed between reservation and broadcast — we cannot know
   * whether the tx left the machine, so it becomes `ambiguous` and keeps
   * counting as spent until a human or the reconciler resolves it.
   */
  private recoverPendingTails(): void {
    const stuck: string[] = [];
    for (const [requestId, track] of this.tracks) {
      if (track.state === "pending") {
        stuck.push(requestId);
      }
    }
    for (const requestId of stuck) {
      this.recordAmbiguous(requestId, "crash-recovery");
      (this.recoveredRequestIds as string[]).push(requestId);
    }
  }

  /**
   * Durably append one record: schema check (a row we could not replay is
   * never written), transition check (typed error, nothing written), then
   * writeSync + fsyncSync, and only then the index update.
   */
  private append<T extends LedgerRecord>(record: T): T {
    if (this.fd === null) {
      throw new LedgerStateError("the ledger is closed");
    }
    const shape = ledgerRecordSchema.safeParse(record);
    if (!shape.success) {
      const detail = shape.error.issues
        .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
        .join("; ");
      throw new LedgerRecordError(`refusing to append a malformed record: ${detail}`);
    }
    const problem = this.transitionProblem(record);
    if (problem !== null) {
      throw new LedgerStateError(problem);
    }
    fs.writeSync(this.fd, JSON.stringify(record) + "\n");
    fs.fsyncSync(this.fd);
    this.apply(record);
    return record;
  }

  /**
   * The state machine, per kind. On-chain (topup/send): pending →
   * broadcast | failed | ambiguous; broadcast → confirmed | ambiguous;
   * confirmed may repeat with a strictly higher count. Off-chain
   * (paid-fetch): pending → settled | failed | ambiguous — there is no
   * broadcast/confirmation, a signature settles or it does not. Shared:
   * ambiguous → resolved; failed, settled and resolved are terminal.
   * Returns a human-readable problem, or null when the record is legal.
   */
  private transitionProblem(record: LedgerRecord): string | null {
    const track = this.tracks.get(record.requestId);
    if (record.type === "pending") {
      return track === undefined
        ? null
        : `duplicate pending row for requestId "${record.requestId}"`;
    }
    if (track === undefined) {
      return `"${record.type}" row for unknown requestId "${record.requestId}"`;
    }
    const illegal = `illegal transition ${track.state} -> ${record.type} for requestId "${record.requestId}"`;
    switch (record.type) {
      case "broadcast":
        if (track.pending.kind === "paid-fetch") {
          return `"broadcast" row for off-chain paid-fetch requestId "${record.requestId}"`;
        }
        return track.state === "pending" ? null : illegal;
      case "settled":
        if (track.pending.kind !== "paid-fetch") {
          return `"settled" row for on-chain ${track.pending.kind} requestId "${record.requestId}"`;
        }
        return track.state === "pending" ? null : illegal;
      case "confirmed": {
        if (track.state !== "broadcast" && track.state !== "confirmed") {
          return illegal;
        }
        if (track.txid !== record.txid) {
          return `confirmed txid ${record.txid} does not match broadcast txid ${String(track.txid)} for requestId "${record.requestId}"`;
        }
        if (track.confirmations !== null && record.confirmations <= track.confirmations) {
          return `confirmations must increase (${track.confirmations} -> ${record.confirmations}) for requestId "${record.requestId}"`;
        }
        return null;
      }
      case "failed": {
        if (track.state !== "pending") {
          return illegal;
        }
        // "build" (never-sent) is shared; the other stages are kind-exclusive:
        // "broadcast-rejected" is on-chain only, "payment-rejected" (a second
        // 402) is paid-fetch only. A cross-kind stage is corruption.
        const isPaidFetch = track.pending.kind === "paid-fetch";
        if (
          (record.stage === "broadcast-rejected" && isPaidFetch) ||
          (record.stage === "payment-rejected" && !isPaidFetch)
        ) {
          return `"failed" stage "${record.stage}" is not valid for ${track.pending.kind} requestId "${record.requestId}"`;
        }
        return null;
      }
      case "ambiguous": {
        if (track.state !== "pending" && track.state !== "broadcast") {
          return illegal;
        }
        // Same per-kind rule for the ambiguity cause (crash-recovery is
        // shared): on-chain rows go ambiguous on a broadcast transport error,
        // paid-fetch rows on a payment transport error.
        if (
          (track.pending.kind === "paid-fetch" && record.cause === "broadcast-transport-error") ||
          (track.pending.kind !== "paid-fetch" && record.cause === "payment-transport-error")
        ) {
          return `"ambiguous" cause "${record.cause}" is not valid for ${track.pending.kind} requestId "${record.requestId}"`;
        }
        return null;
      }
      case "resolved": {
        if (track.state !== "ambiguous") {
          return illegal;
        }
        // Resolving as SPENT requires the on-chain evidence (a txid) for
        // on-chain rows, and forbids a txid for off-chain paid-fetch rows —
        // the invariant the CLI relies on, owned here so every caller obeys it.
        if (record.outcome === "spent") {
          const isPaidFetch = track.pending.kind === "paid-fetch";
          if (isPaidFetch && record.txid !== null) {
            return `off-chain paid-fetch requestId "${record.requestId}" cannot resolve spent with a txid`;
          }
          if (!isPaidFetch && record.txid === null) {
            return `on-chain ${track.pending.kind} requestId "${record.requestId}" must resolve spent with a txid`;
          }
        }
        return null;
      }
    }
  }

  /** Fold one (already validated) record into the index. */
  private apply(record: LedgerRecord): void {
    if (record.type === "pending") {
      this.tracks.set(record.requestId, {
        pending: record,
        pendingAtMs: new Date(record.at).getTime(),
        amountSats: BigInt(record.amountSats),
        state: "pending",
        broadcast: null,
        confirmations: null,
        txid: null,
        failure: null,
        httpStatus: null,
        ambiguousCause: null,
        resolution: null,
      });
      return;
    }
    const track = this.tracks.get(record.requestId);
    if (track === undefined) {
      // transitionProblem guarantees this cannot happen; keep it honest.
      throw new LedgerStateError(`no track for requestId "${record.requestId}"`);
    }
    switch (record.type) {
      case "broadcast":
        track.state = "broadcast";
        track.broadcast = record;
        track.txid = record.txid;
        break;
      case "confirmed":
        track.state = "confirmed";
        track.confirmations = record.confirmations;
        break;
      case "failed":
        track.state = "failed";
        track.failure = { stage: record.stage, error: record.error };
        break;
      case "settled":
        track.state = "settled";
        track.httpStatus = record.httpStatus;
        break;
      case "ambiguous":
        track.state = "ambiguous";
        track.ambiguousCause = record.cause;
        break;
      case "resolved":
        track.state = "resolved";
        track.resolution = { outcome: record.outcome, txid: record.txid, by: record.by };
        if (record.txid !== null) {
          track.txid = record.txid;
        }
        break;
    }
  }

  private snapshot(track: RequestTrack): RequestSnapshot {
    return {
      requestId: track.pending.requestId,
      kind: track.pending.kind,
      recipientAddress: track.pending.recipientAddress,
      recipientName: track.pending.recipientName,
      currency: track.pending.currency,
      amountSats: track.amountSats,
      approval: track.pending.approval,
      policyHash: track.pending.policyHash,
      pendingAt: track.pending.at,
      state: track.state,
      txid: track.txid,
      confirmations: track.confirmations,
      failure: track.failure === null ? null : { ...track.failure },
      httpStatus: track.httpStatus,
      ambiguousCause: track.ambiguousCause,
      resolution: track.resolution === null ? null : { ...track.resolution },
      countsAsSpent: countsAsSpent(track),
    };
  }
}

/**
 * The fail-closed counting rule (RISKS.md): a request counts as spent
 * unless its terminal record proves the money did NOT move — `failed`, or
 * `resolved` with outcome `not-spent`. Pending, broadcast, ambiguous,
 * confirmed, settled and resolved(spent) all count.
 */
function countsAsSpent(track: RequestTrack): boolean {
  if (track.state === "failed") {
    return false;
  }
  if (track.state === "resolved" && track.resolution?.outcome === "not-spent") {
    return false;
  }
  return true;
}
