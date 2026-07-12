import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { intentFingerprint } from "../src/intents.js";
import {
  LedgerCorruptError,
  LedgerLockedError,
  LedgerStateError,
  SpendLedger,
} from "../src/ledger/ledger.js";
import { LedgerRecordError } from "../src/ledger/records.js";
import { FACILITATOR_ADDRESS, NOW, RECIPIENT_ADDRESS, send, topup } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const POLICY_HASH = "policy-hash-1";
const TXID = "a".repeat(64);
const OUTPOINT_1 = `${"c".repeat(64)}:0`;
const OUTPOINT_2 = `${"d".repeat(64)}:7`;
const CHANGE = `${TXID}:1`;

let dirs: string[] = [];
let openLedgers: SpendLedger[] = [];

function newDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-ledger-"));
  dirs.push(dir);
  return dir;
}

/** Open a ledger with an injectable, mutable clock; tracked for cleanup. */
function openAt(dir: string, clock: () => Date = () => NOW): SpendLedger {
  const ledger = SpendLedger.open(dir, { clock });
  openLedgers.push(ledger);
  return ledger;
}

function ledgerPath(dir: string): string {
  return path.join(dir, "ledger.jsonl");
}

function ledgerLines(dir: string): string[] {
  return fs
    .readFileSync(ledgerPath(dir), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

afterEach(() => {
  for (const ledger of openLedgers) {
    ledger.close();
  }
  openLedgers = [];
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("SpendLedger happy path and replay", () => {
  it("replays pending -> broadcast -> confirmed identically after reopen", () => {
    const dir = newDir();
    const intent = topup();
    const ledger = openAt(dir);
    ledger.recordPending(intent, "auto", POLICY_HASH);
    ledger.recordBroadcast(intent.requestId, TXID, [OUTPOINT_1, OUTPOINT_2], CHANGE);
    ledger.recordConfirmed(intent.requestId, TXID, 1);
    ledger.recordConfirmed(intent.requestId, TXID, 3);
    const before = ledger.getOutcome(intent.requestId);
    ledger.close();

    const reopened = openAt(dir);
    const after = reopened.getOutcome(intent.requestId);
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      requestId: intent.requestId,
      kind: "topup",
      currency: "VRSCTEST",
      amountSats: intent.amountSats,
      approval: "auto",
      policyHash: POLICY_HASH,
      pendingAt: NOW.toISOString(),
      state: "confirmed",
      txid: TXID,
      confirmations: 3,
      countsAsSpent: true,
    });
    expect(reopened.totalSpentSats("VRSCTEST")).toBe(intent.amountSats);
    expect(reopened.spentInWindowSats("VRSCTEST", DAY_MS, NOW)).toBe(intent.amountSats);
    expect(reopened.unresolvedAmbiguous()).toEqual([]);
    expect(reopened.recoveredRequestIds).toEqual([]);
  });

  it("returns null for an unknown requestId", () => {
    const ledger = openAt(newDir());
    expect(ledger.getOutcome("req-unknown-01")).toBeNull();
  });

  it("mode of the config dir and ledger file are restrictive", () => {
    const dir = newDir();
    const inner = path.join(dir, "wallet");
    const ledger = openAt(inner);
    ledger.recordPending(topup(), "auto", POLICY_HASH);
    expect(fs.statSync(inner).mode & 0o777).toBe(0o700);
    expect(fs.statSync(ledgerPath(inner)).mode & 0o777).toBe(0o600);
  });
});

describe("SpendLedger corruption refusal", () => {
  it("refuses to open on a torn final line (partial JSON, no newline)", () => {
    const dir = newDir();
    const ledger = openAt(dir);
    ledger.recordPending(topup(), "auto", POLICY_HASH);
    ledger.close();
    fs.appendFileSync(ledgerPath(dir), '{"v":1,"type":"broadc');
    expect(() => openAt(dir)).toThrow(LedgerCorruptError);
    expect(() => openAt(dir)).toThrow(/repair-tail/);
  });

  it("refuses a torn line that is a clean prefix of a full record", () => {
    const dir = newDir();
    const ledger = openAt(dir);
    const pending = ledger.recordPending(topup(), "auto", POLICY_HASH);
    ledger.close();
    // A COMPLETE, parseable record missing only its terminating newline is
    // still a torn append and must refuse.
    fs.appendFileSync(
      ledgerPath(dir),
      JSON.stringify({
        v: 1,
        type: "ambiguous",
        requestId: pending.requestId,
        cause: "crash-recovery",
        at: NOW.toISOString(),
      }),
    );
    expect(() => openAt(dir)).toThrow(LedgerCorruptError);
  });

  it("refuses an unparsable line in the middle of the file (no silent skips)", () => {
    const dir = newDir();
    const ledger = openAt(dir);
    ledger.recordPending(topup(), "auto", POLICY_HASH);
    ledger.recordFailed(topup().requestId, "build", { message: "boom" });
    ledger.close();
    const lines = ledgerLines(dir);
    lines.splice(1, 0, "definitely not json");
    fs.writeFileSync(ledgerPath(dir), lines.join("\n") + "\n");
    expect(() => openAt(dir)).toThrow(LedgerCorruptError);
  });

  it("refuses a history the state machine forbids (tampered file)", () => {
    const dir = newDir();
    const ledger = openAt(dir);
    ledger.recordPending(topup(), "auto", POLICY_HASH);
    ledger.close();
    // resolved without an ambiguous first is impossible.
    fs.appendFileSync(
      ledgerPath(dir),
      JSON.stringify({
        v: 1,
        type: "resolved",
        requestId: topup().requestId,
        outcome: "not-spent",
        txid: null,
        by: "cli-resolve",
        at: NOW.toISOString(),
      }) + "\n",
    );
    expect(() => openAt(dir)).toThrow(LedgerCorruptError);
  });

  it("a failed open releases the lock so a later open can succeed", () => {
    const dir = newDir();
    fs.writeFileSync(ledgerPath(dir), "torn");
    expect(() => openAt(dir)).toThrow(LedgerCorruptError);
    fs.rmSync(ledgerPath(dir));
    expect(() => openAt(dir)).not.toThrow();
  });
});

describe("SpendLedger crash recovery", () => {
  it("turns a pending tail into ambiguous(crash-recovery) that counts as spent", () => {
    const dir = newDir();
    const intent = topup();
    const first = openAt(dir);
    first.recordPending(intent, "auto", POLICY_HASH);
    first.close(); // simulated crash between pending and broadcast

    const reopened = openAt(dir);
    expect(reopened.recoveredRequestIds).toEqual([intent.requestId]);
    expect(reopened.getOutcome(intent.requestId)).toMatchObject({
      state: "ambiguous",
      ambiguousCause: "crash-recovery",
      countsAsSpent: true,
    });
    expect(reopened.unresolvedAmbiguous()).toHaveLength(1);
    expect(reopened.spentInWindowSats("VRSCTEST", DAY_MS, NOW)).toBe(intent.amountSats);
    expect(reopened.totalSpentSats("VRSCTEST")).toBe(intent.amountSats);
    // The recovery row is durable: two lines on disk, none added on reopen.
    expect(ledgerLines(dir)).toHaveLength(2);
    reopened.close();
    const third = openAt(dir);
    expect(third.recoveredRequestIds).toEqual([]);
    expect(ledgerLines(dir)).toHaveLength(2);
  });

  it("leaves a broadcast tail alone (the reconciler's job, not recovery's)", () => {
    const dir = newDir();
    const intent = topup();
    const first = openAt(dir);
    first.recordPending(intent, "auto", POLICY_HASH);
    first.recordBroadcast(intent.requestId, TXID, [OUTPOINT_1], null);
    first.close();

    const reopened = openAt(dir);
    expect(reopened.recoveredRequestIds).toEqual([]);
    expect(reopened.getOutcome(intent.requestId)?.state).toBe("broadcast");
  });
});

describe("SpendLedger fail-closed counting", () => {
  it("failed releases the reservation but still counts as an attempt", () => {
    const ledger = openAt(newDir());
    const intent = topup();
    ledger.recordPending(intent, "auto", POLICY_HASH);
    ledger.recordFailed(intent.requestId, "broadcast-rejected", {
      code: -26,
      message: "rejected",
    });
    expect(ledger.spentInWindowSats("VRSCTEST", DAY_MS, NOW)).toBe(0n);
    expect(ledger.facilitatorSpentInWindowSats(FACILITATOR_ADDRESS, "VRSCTEST", DAY_MS, NOW)).toBe(
      0n,
    );
    expect(ledger.totalSpentSats("VRSCTEST")).toBe(0n);
    expect(ledger.hasFingerprintInWindow(intentFingerprint(intent), DAY_MS, NOW)).toBe(false);
    expect(ledger.attemptsInWindow(DAY_MS, NOW)).toBe(1);
    expect(ledger.lastAttemptAt()).toEqual(NOW);
  });

  it("ambiguous and resolved(spent) count; resolved(not-spent) releases", () => {
    const ledger = openAt(newDir());
    const ambiguous = topup({ requestId: "req-ambiguous-1" });
    const spent = topup({ requestId: "req-spent-0001" });
    const notSpent = topup({ requestId: "req-notspent-1" });
    for (const intent of [ambiguous, spent, notSpent]) {
      ledger.recordPending(intent, "auto", POLICY_HASH);
      ledger.recordAmbiguous(intent.requestId, "broadcast-transport-error");
    }
    ledger.recordResolved(spent.requestId, "spent", TXID, "reconciler");
    ledger.recordResolved(notSpent.requestId, "not-spent", null, "cli-resolve");

    // ambiguous + resolved(spent) = 2 x 0.1; resolved(not-spent) released.
    const expected = ambiguous.amountSats + spent.amountSats;
    expect(ledger.spentInWindowSats("VRSCTEST", DAY_MS, NOW)).toBe(expected);
    expect(ledger.totalSpentSats("VRSCTEST")).toBe(expected);
    expect(ledger.attemptsInWindow(DAY_MS, NOW)).toBe(3);
    expect(ledger.unresolvedAmbiguous().map((s) => s.requestId)).toEqual([ambiguous.requestId]);
    expect(ledger.getOutcome(spent.requestId)).toMatchObject({
      state: "resolved",
      txid: TXID,
      resolution: { outcome: "spent", txid: TXID, by: "reconciler" },
      countsAsSpent: true,
    });
    expect(ledger.getOutcome(notSpent.requestId)?.countsAsSpent).toBe(false);
  });
});

describe("SpendLedger rolling windows", () => {
  it("counts a row exactly at the window edge, excludes one just outside", () => {
    const dir = newDir();
    let now = NOW;
    const ledger = openAt(dir, () => now);
    const intent = topup();
    ledger.recordPending(intent, "auto", POLICY_HASH);

    const atEdge = new Date(NOW.getTime() + DAY_MS);
    const pastEdge = new Date(NOW.getTime() + DAY_MS + 1);
    expect(ledger.spentInWindowSats("VRSCTEST", DAY_MS, atEdge)).toBe(intent.amountSats);
    expect(ledger.spentInWindowSats("VRSCTEST", DAY_MS, pastEdge)).toBe(0n);
    expect(ledger.attemptsInWindow(DAY_MS, atEdge)).toBe(1);
    expect(ledger.attemptsInWindow(DAY_MS, pastEdge)).toBe(0);
    expect(ledger.hasFingerprintInWindow(intentFingerprint(intent), DAY_MS, atEdge)).toBe(true);
    expect(ledger.hasFingerprintInWindow(intentFingerprint(intent), DAY_MS, pastEdge)).toBe(false);
    // The lifetime aggregate has no window.
    expect(ledger.totalSpentSats("VRSCTEST")).toBe(intent.amountSats);

    // The window is timed by the PENDING row even after later records.
    now = pastEdge;
    ledger.recordAmbiguous(intent.requestId, "broadcast-transport-error");
    expect(ledger.spentInWindowSats("VRSCTEST", DAY_MS, pastEdge)).toBe(0n);
  });

  it("lastAttemptAt is the most recent pending row", () => {
    let now = NOW;
    const ledger = openAt(newDir(), () => now);
    ledger.recordPending(topup({ requestId: "req-first-0001" }), "auto", POLICY_HASH);
    now = new Date(NOW.getTime() + 60_000);
    ledger.recordPending(topup({ requestId: "req-second-001" }), "auto", POLICY_HASH);
    expect(ledger.lastAttemptAt()).toEqual(now);
  });
});

describe("SpendLedger facilitator and currency isolation", () => {
  it("isolates facilitator aggregates by address AND currency", () => {
    const ledger = openAt(newDir());
    const a = topup({ requestId: "req-facil-a-01" });
    const b = topup({
      requestId: "req-facil-b-01",
      recipientAddress: "ROtherFacilitator11111111111111111",
      recipientName: "other",
    });
    const c = topup({ requestId: "req-facil-c-01", currency: "TOKEN" });
    for (const intent of [a, b, c]) {
      ledger.recordPending(intent, "auto", POLICY_HASH);
    }
    expect(ledger.facilitatorSpentInWindowSats(FACILITATOR_ADDRESS, "VRSCTEST", DAY_MS, NOW)).toBe(
      a.amountSats,
    );
    expect(ledger.facilitatorSpentInWindowSats(b.recipientAddress, "VRSCTEST", DAY_MS, NOW)).toBe(
      b.amountSats,
    );
    expect(ledger.facilitatorSpentInWindowSats(FACILITATOR_ADDRESS, "TOKEN", DAY_MS, NOW)).toBe(
      c.amountSats,
    );
    expect(ledger.spentInWindowSats("VRSCTEST", DAY_MS, NOW)).toBe(a.amountSats + b.amountSats);
    expect(ledger.spentInWindowSats("TOKEN", DAY_MS, NOW)).toBe(c.amountSats);
  });

  it("matches ANY pending row's recipientAddress, not only topups", () => {
    const ledger = openAt(newDir());
    // A send whose recipient happens to be the facilitator's address must
    // count against that facilitator's budget too (fail closed).
    const intent = send({ recipientAddress: FACILITATOR_ADDRESS, recipientName: "alias" });
    ledger.recordPending(intent, "human-confirmed", POLICY_HASH);
    expect(ledger.facilitatorSpentInWindowSats(FACILITATOR_ADDRESS, "VRSCTEST", DAY_MS, NOW)).toBe(
      intent.amountSats,
    );
    expect(ledger.facilitatorSpentInWindowSats(RECIPIENT_ADDRESS, "VRSCTEST", DAY_MS, NOW)).toBe(
      0n,
    );
  });

  it("attemptsInWindow counts across currencies, failures included", () => {
    const ledger = openAt(newDir());
    ledger.recordPending(topup({ requestId: "req-native-001" }), "auto", POLICY_HASH);
    ledger.recordPending(
      topup({ requestId: "req-token-0001", currency: "TOKEN" }),
      "auto",
      POLICY_HASH,
    );
    ledger.recordFailed("req-token-0001", "build", { message: "boom" });
    expect(ledger.attemptsInWindow(DAY_MS, NOW)).toBe(2);
  });
});

describe("SpendLedger transitions", () => {
  function expectNothingWritten(
    dir: string,
    act: () => void,
    error: new (message: string) => Error,
  ): void {
    const sizeBefore = fs.statSync(ledgerPath(dir)).size;
    expect(act).toThrow(error);
    expect(fs.statSync(ledgerPath(dir)).size).toBe(sizeBefore);
  }

  it("rejects a duplicate pending requestId and writes nothing", () => {
    const dir = newDir();
    const ledger = openAt(dir);
    ledger.recordPending(topup(), "auto", POLICY_HASH);
    expectNothingWritten(
      dir,
      () => ledger.recordPending(topup(), "auto", POLICY_HASH),
      LedgerStateError,
    );
  });

  it("rejects every illegal transition and writes nothing", () => {
    const dir = newDir();
    const ledger = openAt(dir);
    const intent = topup();
    const id = intent.requestId;
    ledger.recordPending(intent, "auto", POLICY_HASH);

    // From pending: confirmed and resolved are illegal.
    expectNothingWritten(dir, () => ledger.recordConfirmed(id, TXID, 1), LedgerStateError);
    expectNothingWritten(
      dir,
      () => ledger.recordResolved(id, "spent", TXID, "reconciler"),
      LedgerStateError,
    );

    ledger.recordBroadcast(id, TXID, [OUTPOINT_1], null);
    // From broadcast: broadcast again and failed are illegal (a tx that
    // left the machine can never be a definitive non-spend).
    expectNothingWritten(
      dir,
      () => ledger.recordBroadcast(id, TXID, [OUTPOINT_1], null),
      LedgerStateError,
    );
    expectNothingWritten(
      dir,
      () => ledger.recordFailed(id, "broadcast-rejected", { message: "late" }),
      LedgerStateError,
    );

    ledger.recordConfirmed(id, TXID, 2);
    // Confirmed repeats only with strictly higher counts and the same txid.
    expectNothingWritten(dir, () => ledger.recordConfirmed(id, TXID, 2), LedgerStateError);
    expectNothingWritten(dir, () => ledger.recordConfirmed(id, TXID, 1), LedgerStateError);
    expectNothingWritten(
      dir,
      () => ledger.recordConfirmed(id, "b".repeat(64), 5),
      LedgerStateError,
    );
    // Confirmed is terminal for everything else.
    expectNothingWritten(
      dir,
      () => ledger.recordAmbiguous(id, "broadcast-transport-error"),
      LedgerStateError,
    );

    // Records for an unknown requestId are refused.
    expectNothingWritten(
      dir,
      () => ledger.recordBroadcast("req-nobody-0001", TXID, [], null),
      LedgerStateError,
    );
  });

  it("resolved and failed are terminal", () => {
    const dir = newDir();
    const ledger = openAt(dir);
    const failed = topup({ requestId: "req-failed-0001" });
    const resolved = topup({ requestId: "req-resolved-01" });
    ledger.recordPending(failed, "auto", POLICY_HASH);
    ledger.recordFailed(failed.requestId, "build", { message: "boom" });
    ledger.recordPending(resolved, "auto", POLICY_HASH);
    ledger.recordAmbiguous(resolved.requestId, "broadcast-transport-error");
    ledger.recordResolved(resolved.requestId, "not-spent", null, "cli-resolve");
    expectNothingWritten(
      dir,
      () => ledger.recordBroadcast(failed.requestId, TXID, [], null),
      LedgerStateError,
    );
    expectNothingWritten(
      dir,
      () => ledger.recordResolved(resolved.requestId, "spent", TXID, "reconciler"),
      LedgerStateError,
    );
  });

  it("refuses to append a malformed record (bad txid) and writes nothing", () => {
    const dir = newDir();
    const ledger = openAt(dir);
    ledger.recordPending(topup(), "auto", POLICY_HASH);
    expectNothingWritten(
      dir,
      () => ledger.recordBroadcast(topup().requestId, "not-a-txid", [], null),
      LedgerRecordError,
    );
  });

  it("refuses appends after close", () => {
    const dir = newDir();
    const ledger = openAt(dir);
    ledger.close();
    expect(() => ledger.recordPending(topup(), "auto", POLICY_HASH)).toThrow(LedgerStateError);
  });
});

describe("SpendLedger lock", () => {
  it("a second open on the same dir throws LedgerLockedError", () => {
    const dir = newDir();
    openAt(dir);
    expect(() => SpendLedger.open(dir)).toThrow(LedgerLockedError);
  });

  it("close releases the lock for the next open", () => {
    const dir = newDir();
    const first = openAt(dir);
    first.close();
    expect(() => openAt(dir)).not.toThrow();
  });

  it("takes over a stale lock whose pid is provably dead", () => {
    const dir = newDir();
    // A just-reaped child pid is dead by the time spawnSync returns.
    const child = spawnSync(process.execPath, ["--version"]);
    expect(child.status).toBe(0);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ledger.lock"), `${child.pid}\n`);
    const ledger = openAt(dir);
    ledger.recordPending(topup(), "auto", POLICY_HASH);
    expect(fs.readFileSync(path.join(dir, "ledger.lock"), "utf8")).toBe(`${process.pid}\n`);
  });

  it("refuses an unreadable lock file (cannot prove the holder dead)", () => {
    const dir = newDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ledger.lock"), "not-a-pid\n");
    expect(() => openAt(dir)).toThrow(LedgerLockedError);
  });
});

describe("SpendLedger outpoint tracking", () => {
  it("tracks in-flight spent outpoints and pending change until confirmed", () => {
    const ledger = openAt(newDir());
    const intent = topup();
    ledger.recordPending(intent, "auto", POLICY_HASH);
    expect(ledger.spentOutpointsInFlight()).toEqual([]);
    expect(ledger.pendingChangeOutpoints()).toEqual([]);

    ledger.recordBroadcast(intent.requestId, TXID, [OUTPOINT_1, OUTPOINT_2], CHANGE);
    expect(ledger.spentOutpointsInFlight().sort()).toEqual([OUTPOINT_1, OUTPOINT_2].sort());
    expect(ledger.pendingChangeOutpoints()).toEqual([CHANGE]);

    ledger.recordConfirmed(intent.requestId, TXID, 1);
    expect(ledger.spentOutpointsInFlight()).toEqual([]);
    expect(ledger.pendingChangeOutpoints()).toEqual([]);
  });

  it("keeps ambiguous broadcasts' inputs reserved but never offers their change", () => {
    const ledger = openAt(newDir());
    const intent = topup();
    ledger.recordPending(intent, "auto", POLICY_HASH);
    ledger.recordBroadcast(intent.requestId, TXID, [OUTPOINT_1], CHANGE);
    ledger.recordAmbiguous(intent.requestId, "broadcast-transport-error");
    expect(ledger.spentOutpointsInFlight()).toEqual([OUTPOINT_1]);
    expect(ledger.pendingChangeOutpoints()).toEqual([]);

    ledger.recordResolved(intent.requestId, "not-spent", null, "cli-resolve");
    expect(ledger.spentOutpointsInFlight()).toEqual([]);
  });

  it("omits change when the broadcast had none", () => {
    const ledger = openAt(newDir());
    const intent = topup();
    ledger.recordPending(intent, "auto", POLICY_HASH);
    ledger.recordBroadcast(intent.requestId, TXID, [OUTPOINT_1], null);
    expect(ledger.pendingChangeOutpoints()).toEqual([]);
  });
});
