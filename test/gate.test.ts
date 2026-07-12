// WalletGate end-to-end tests: real SpendLedger, AuditLog and PolicySource
// on temp-dir files, MockBackend + StaticConfirmer at the boundaries. No
// network anywhere — the backend interface is the E3 seam.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseAmount } from "verus-rpc";
import { afterEach, describe, expect, it } from "vitest";

import { AuditLog, auditLineSchema, type AuditLine } from "../src/audit.js";
import { MockBackend, type SpendReceipt } from "../src/backend.js";
import { StaticConfirmer, type Confirmer, type ConfirmOutcome } from "../src/confirm.js";
import { WalletGate } from "../src/gate.js";
import { SpendLedger, type RequestState } from "../src/ledger/ledger.js";
import { PolicySource } from "../src/policy/load.js";
import type { PolicyFileInput } from "../src/policy/schema.js";
import { readState, writeState } from "../src/state-io.js";
import type { WalletState } from "../src/state.js";
import {
  FACILITATOR_ADDRESS,
  isoAt,
  NOW,
  policyFile,
  RECIPIENT_ADDRESS,
  send,
  topup,
} from "./helpers.js";

const TXID_A = "a".repeat(64);
const TXID_B = "b".repeat(64);
const INPUT_OUTPOINT = `${"c".repeat(64)}:0`;

function receiptFor(txid: string): SpendReceipt {
  return { txid, spentOutpoints: [INPUT_OUTPOINT], changeOutpoint: `${txid}:1` };
}

let dirs: string[] = [];
let ledgers: SpendLedger[] = [];
let audits: AuditLog[] = [];

function newDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-gate-"));
  dirs.push(dir);
  return dir;
}

function policyPath(dir: string): string {
  return path.join(dir, "policy.json");
}

function writePolicy(dir: string, file: PolicyFileInput): void {
  fs.writeFileSync(policyPath(dir), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

/** Force a visibly different mtime so the stat-based freshness must fire. */
function bumpMtime(dir: string): void {
  const at = new Date(Date.now() + 5_000);
  fs.utimesSync(policyPath(dir), at, at);
}

function auditEvents(dir: string): AuditLine[] {
  const file = path.join(dir, "audit.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => auditLineSchema.parse(JSON.parse(line)));
}

function ledgerLines(dir: string): string[] {
  return fs
    .readFileSync(path.join(dir, "ledger.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

interface Harness {
  dir: string;
  gate: WalletGate;
  backend: MockBackend;
  ledger: SpendLedger;
  clock: () => Date;
  setNow(at: Date): void;
}

function setup(
  opts: {
    confirmer?: Confirmer;
    backend?: MockBackend;
    policy?: Partial<PolicyFileInput>;
    state?: WalletState;
  } = {},
): Harness {
  const dir = newDir();
  writePolicy(dir, policyFile(opts.policy ?? {}));
  if (opts.state !== undefined) {
    writeState(dir, opts.state);
  }
  const clockBox = { now: NOW };
  const clock = (): Date => clockBox.now;
  const ledger = SpendLedger.open(dir, { clock });
  ledgers.push(ledger);
  const audit = AuditLog.open(dir, { clock });
  audits.push(audit);
  const backend = opts.backend ?? new MockBackend();
  const gate = new WalletGate({
    policySource: new PolicySource(dir),
    ledger,
    backend,
    confirmer: opts.confirmer ?? new StaticConfirmer("approved"),
    audit,
    stateDir: dir,
    clock,
  });
  return {
    dir,
    gate,
    backend,
    ledger,
    clock,
    setNow: (at) => {
      clockBox.now = at;
    },
  };
}

afterEach(() => {
  for (const ledger of ledgers) {
    ledger.close();
  }
  ledgers = [];
  for (const audit of audits) {
    audit.close();
  }
  audits = [];
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("WalletGate auto path", () => {
  it("an in-budget autoApprove topup commits with exactly one spend and no confirm", async () => {
    const confirmer = new StaticConfirmer("approved");
    const h = setup({ confirmer });
    h.backend.willSucceed(receiptFor(TXID_A));

    const outcome = await h.gate.execute(topup());

    expect(outcome).toEqual({ status: "committed", requestId: "req-topup-0001", txid: TXID_A });
    expect(h.backend.instructions).toHaveLength(1);
    expect(h.backend.instructions[0]).toEqual({
      fromAddress: "RAgent1111111111111111111111111111",
      toAddress: FACILITATOR_ADDRESS,
      amountSats: parseAmount("0.1"),
      currency: "VRSCTEST",
      excludeOutpoints: [],
      spendableUnconfirmedChange: [],
    });
    const expectedHash = createHash("sha256")
      .update(fs.readFileSync(policyPath(h.dir)))
      .digest("hex");
    expect(h.ledger.getOutcome("req-topup-0001")).toMatchObject({
      state: "broadcast",
      approval: "auto",
      txid: TXID_A,
      policyHash: expectedHash,
      countsAsSpent: true,
    });
    expect(confirmer.received).toHaveLength(0);
    expect(auditEvents(h.dir).map((line) => line.event)).not.toContain("confirm-requested");
  });

  it("a follow-up spend carries the in-flight outpoints and clean change", async () => {
    const h = setup();
    h.backend.willSucceed(receiptFor(TXID_A)).willSucceed(receiptFor(TXID_B));

    await h.gate.execute(topup());
    const second = await h.gate.execute(
      topup({ requestId: "req-topup-0002", amountSats: parseAmount("0.2") }),
    );

    expect(second.status).toBe("committed");
    expect(h.backend.instructions[1]).toMatchObject({
      excludeOutpoints: [INPUT_OUTPOINT],
      spendableUnconfirmedChange: [`${TXID_A}:1`],
    });
  });

  it("a committed spend depletes an active grant in state.json (step 11)", async () => {
    const h = setup({
      state: {
        schemaVersion: 1,
        armedUntil: null,
        grant: { currency: "VRSCTEST", remainingSats: parseAmount("1"), expiresAt: isoAt(3_600_000) },
      },
    });
    h.backend.willSucceed(receiptFor(TXID_A));

    const outcome = await h.gate.execute(topup());

    expect(outcome.status).toBe("committed");
    expect(readState(h.dir).grant?.remainingSats).toBe(parseAmount("0.9"));
  });
});

describe("WalletGate confirm path", () => {
  it("an approved confirmation executes the spend as human-confirmed", async () => {
    const confirmer = new StaticConfirmer("approved");
    const h = setup({ confirmer });
    h.backend.willSucceed(receiptFor(TXID_A));

    const outcome = await h.gate.execute(send());

    expect(outcome).toEqual({ status: "committed", requestId: "req-send-00001", txid: TXID_A });
    expect(h.ledger.getOutcome("req-send-00001")).toMatchObject({
      state: "broadcast",
      approval: "human-confirmed",
    });
    expect(confirmer.received).toHaveLength(1);
    expect(confirmer.received[0]?.timeoutMs).toBe(120_000);
    expect(confirmer.received[0]?.message).toContain(`alice (${RECIPIENT_ADDRESS})`);
    expect(confirmer.received[0]?.message).toContain("send-always-confirms");
    const events = auditEvents(h.dir).map((line) => line.event);
    expect(events).toContain("confirm-requested");
    expect(events).toContain("confirm-approved");
  });

  it("a declined confirmation denies with human-declined and spends nothing", async () => {
    const h = setup({ confirmer: new StaticConfirmer("denied") });

    const outcome = await h.gate.execute(send());

    expect(outcome).toMatchObject({ status: "denied", reasonCode: "human-declined" });
    expect(h.backend.instructions).toHaveLength(0);
    expect(h.ledger.getOutcome("req-send-00001")).toBeNull();
    expect(ledgerLines(h.dir)).toHaveLength(0);
    expect(auditEvents(h.dir).map((line) => line.event)).toContain("confirm-declined");
  });

  it("a timeout denies with confirm-timeout and spends nothing", async () => {
    const h = setup({ confirmer: new StaticConfirmer("timeout") });

    const outcome = await h.gate.execute(send());

    expect(outcome).toMatchObject({ status: "denied", reasonCode: "confirm-timeout" });
    expect(h.backend.instructions).toHaveLength(0);
    expect(ledgerLines(h.dir)).toHaveLength(0);
    expect(auditEvents(h.dir).map((line) => line.event)).toContain("confirm-timeout");
  });

  it("a channel that vanishes mid-confirm is treated as a timeout", async () => {
    const h = setup({ confirmer: new StaticConfirmer("unavailable") });

    const outcome = await h.gate.execute(send());

    expect(outcome).toMatchObject({ status: "denied", reasonCode: "confirm-timeout" });
    expect(h.backend.instructions).toHaveLength(0);
  });

  it("no elicitation capability denies fail-closed before any confirm request", async () => {
    const confirmer = new StaticConfirmer("approved", { available: false });
    const h = setup({ confirmer });

    const outcome = await h.gate.execute(send());

    expect(outcome).toMatchObject({ status: "denied", reasonCode: "no-elicitation" });
    expect(outcome.status === "denied" && outcome.humanText).toMatch(/elicitation/);
    expect(confirmer.received).toHaveLength(0);
    expect(h.backend.instructions).toHaveLength(0);
    expect(ledgerLines(h.dir)).toHaveLength(0);
    const denied = auditEvents(h.dir).find((line) => line.event === "intent-denied");
    expect(denied).toMatchObject({ event: "intent-denied", reasonCode: "no-elicitation" });
  });

  it("re-evaluates after the human pause: an arm window that expired denies", async () => {
    let advance: () => void = () => {};
    const confirmer = new StaticConfirmer("approved", {
      onConfirm: () => {
        advance();
      },
    });
    const h = setup({
      policy: { armRequired: true },
      state: { schemaVersion: 1, armedUntil: isoAt(60_000), grant: null },
      confirmer,
    });
    advance = () => {
      h.setNow(new Date(NOW.getTime() + 120_000));
    };
    h.backend.willSucceed(receiptFor(TXID_A));

    const outcome = await h.gate.execute(send());

    expect(outcome).toMatchObject({ status: "denied", reasonCode: "not-armed" });
    expect(h.backend.instructions).toHaveLength(0);
    expect(ledgerLines(h.dir)).toHaveLength(0);
    const events = auditEvents(h.dir).map((line) => line.event);
    expect(events).toEqual(["confirm-requested", "confirm-approved", "intent-denied"]);
  });
});

describe("WalletGate deny and replay", () => {
  it("an over-cap intent denies with zero backend calls and zero ledger rows", async () => {
    const h = setup();

    const outcome = await h.gate.execute(topup({ amountSats: parseAmount("3") }));

    expect(outcome).toMatchObject({ status: "denied", reasonCode: "per-tx-cap-exceeded" });
    expect(h.backend.instructions).toHaveLength(0);
    expect(ledgerLines(h.dir)).toHaveLength(0);
    const denied = auditEvents(h.dir).find((line) => line.event === "intent-denied");
    expect(denied).toMatchObject({
      reasonCode: "per-tx-cap-exceeded",
      requestId: "req-topup-0001",
      currency: "VRSCTEST",
    });
  });

  it("replaying a known requestId returns the recorded outcome, never a second spend", async () => {
    const h = setup();
    h.backend.willSucceed(receiptFor(TXID_A));

    const first = await h.gate.execute(topup());
    const replay = await h.gate.execute(topup());

    expect(first.status).toBe("committed");
    expect(replay.status).toBe("replayed");
    if (replay.status === "replayed") {
      expect(replay.snapshot).toMatchObject({ state: "broadcast", txid: TXID_A });
    }
    expect(h.backend.instructions).toHaveLength(1);
  });

  it("a closed (unwritable) ledger denies the reservation without any spend attempt", async () => {
    const h = setup();
    h.ledger.close();

    const outcome = await h.gate.execute(topup());

    expect(outcome).toMatchObject({ status: "denied", reasonCode: "ledger-unwritable" });
    expect(h.backend.instructions).toHaveLength(0);
  });
});

describe("WalletGate execution failures", () => {
  it("a rejected spend records failed and releases the reservation for a retry", async () => {
    const h = setup();
    h.backend
      .willReject("broadcast-rejected", "bad-txns-inputs-spent", -26)
      .willSucceed(receiptFor(TXID_A));

    const outcome = await h.gate.execute(topup());

    expect(outcome).toMatchObject({ status: "failed", stage: "broadcast-rejected" });
    expect(h.ledger.getOutcome("req-topup-0001")).toMatchObject({
      state: "failed",
      failure: { stage: "broadcast-rejected", error: { code: -26, message: "bad-txns-inputs-spent" } },
      countsAsSpent: false,
    });

    // The identical transfer under a fresh requestId passes policy again.
    const retry = await h.gate.execute(topup({ requestId: "req-topup-0002" }));
    expect(retry).toMatchObject({ status: "committed", txid: TXID_A });
    expect(h.backend.instructions).toHaveLength(2);
  });

  it("an uncertain broadcast records ambiguous and keeps the reservation", async () => {
    const h = setup();
    h.backend.willBeUncertain("socket hang up after send");

    const outcome = await h.gate.execute(topup());

    expect(outcome).toMatchObject({ status: "ambiguous", requestId: "req-topup-0001" });
    expect(h.ledger.getOutcome("req-topup-0001")).toMatchObject({
      state: "ambiguous",
      ambiguousCause: "broadcast-transport-error",
      countsAsSpent: true,
    });

    // Inside the dedupe window the identical transfer is refused.
    const dup = await h.gate.execute(topup({ requestId: "req-topup-0002" }));
    expect(dup).toMatchObject({ status: "denied", reasonCode: "duplicate-intent" });
    expect(h.backend.instructions).toHaveLength(1);
  });

  it("ANY unexpected backend throw is treated as ambiguous, never as failed", async () => {
    const h = setup();
    h.backend.willThrow(new Error("kaboom"));

    const outcome = await h.gate.execute(topup());

    expect(outcome.status).toBe("ambiguous");
    expect(h.ledger.getOutcome("req-topup-0001")?.state).toBe("ambiguous");
  });

  it("the pending row is durable BEFORE the backend executes", async () => {
    const seen: (RequestState | undefined)[] = [];
    let ledgerRef: SpendLedger | null = null;
    const backend = new MockBackend({
      onExecute: () => {
        seen.push(ledgerRef?.getOutcome("req-topup-0001")?.state);
      },
    });
    backend.willSucceed(receiptFor(TXID_A));
    const h = setup({ backend });
    ledgerRef = h.ledger;

    await h.gate.execute(topup());

    expect(seen).toEqual(["pending"]);
  });
});

describe("WalletGate policy freshness", () => {
  it("picks up a policy change between calls: a removed facilitator denies", async () => {
    const h = setup();
    h.backend.willSucceed(receiptFor(TXID_A));
    await h.gate.execute(topup());

    writePolicy(h.dir, policyFile({ facilitators: [] }));
    bumpMtime(h.dir);
    const outcome = await h.gate.execute(
      topup({ requestId: "req-topup-0002", amountSats: parseAmount("0.2") }),
    );

    expect(outcome).toMatchObject({ status: "denied", reasonCode: "recipient-not-listed" });
    expect(h.backend.instructions).toHaveLength(1);
    expect(auditEvents(h.dir).map((line) => line.event)).toContain("policy-reload");
  });

  it("a corrupted policy file denies policy-unreadable with nothing written", async () => {
    const h = setup();
    fs.writeFileSync(policyPath(h.dir), "{ not json", { mode: 0o600 });

    const outcome = await h.gate.execute(topup());

    expect(outcome).toMatchObject({ status: "denied", reasonCode: "policy-unreadable" });
    expect(h.backend.instructions).toHaveLength(0);
    expect(ledgerLines(h.dir)).toHaveLength(0);
    const denied = auditEvents(h.dir).find((line) => line.event === "intent-denied");
    expect(denied).toMatchObject({ reasonCode: "policy-unreadable" });
  });
});

describe("WalletGate mutex", () => {
  it("a second execute while a confirmation is pending denies spend-in-flight", async () => {
    let release: (outcome: ConfirmOutcome) => void = () => {};
    let signalRequested: () => void = () => {};
    const requested = new Promise<void>((resolve) => {
      signalRequested = resolve;
    });
    const confirmer: Confirmer = {
      available: () => true,
      confirm: () => {
        signalRequested();
        return new Promise<ConfirmOutcome>((resolve) => {
          release = resolve;
        });
      },
    };
    const h = setup({ confirmer });
    h.backend.willSucceed(receiptFor(TXID_A));

    const first = h.gate.execute(send());
    await requested;
    const second = await h.gate.execute(send({ requestId: "req-send-00002" }));
    expect(second).toMatchObject({ status: "denied", reasonCode: "spend-in-flight" });

    release("approved");
    await expect(first).resolves.toMatchObject({ status: "committed", txid: TXID_A });
    expect(h.backend.instructions).toHaveLength(1);
  });
});

describe("WalletGate end to end on disk", () => {
  it("a committed spend survives a ledger reopen with identical accounting", async () => {
    const h = setup();
    h.backend.willSucceed(receiptFor(TXID_A));
    await h.gate.execute(topup());
    h.ledger.close();

    const reopened = SpendLedger.open(h.dir, { clock: h.clock });
    ledgers.push(reopened);
    expect(reopened.getOutcome("req-topup-0001")).toMatchObject({
      state: "broadcast",
      txid: TXID_A,
      countsAsSpent: true,
    });
    expect(reopened.totalSpentSats("VRSCTEST")).toBe(parseAmount("0.1"));
    // Every audit line on disk parses against the strict schema.
    expect(auditEvents(h.dir).length).toBeGreaterThanOrEqual(0);
  });
});
