// The ledger's off-chain "paid-fetch" rows: the settled state, the per-kind
// state machine guards, crash recovery, and the strict split between the
// on-chain and paid-fetch aggregates (no double-counting).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseAmount } from "@chainvue/verus-rpc";
import { afterEach, describe, expect, it } from "vitest";

import { LedgerStateError, SpendLedger } from "../src/ledger/ledger.js";
import { NOW, paidFetch, topup } from "./helpers.js";

const dirs: string[] = [];
let clockMs = NOW.getTime();

function openLedger(dir?: string): { ledger: SpendLedger; dir: string } {
  const target = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "peculium-pfledger-"));
  if (dir === undefined) {
    dirs.push(target);
  }
  const ledger = SpendLedger.open(target, { clock: () => new Date(clockMs) });
  return { ledger, dir: target };
}

afterEach(() => {
  clockMs = NOW.getTime();
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("paid-fetch state machine", () => {
  it("settles a pending paid-fetch with the http status", () => {
    const { ledger } = openLedger();
    ledger.recordPending(paidFetch(), "auto", "hash-1");
    ledger.recordSettled("req-fetch-0001", 200);
    const snapshot = ledger.getOutcome("req-fetch-0001");
    expect(snapshot?.state).toBe("settled");
    expect(snapshot?.kind).toBe("paid-fetch");
    expect(snapshot?.httpStatus).toBe(200);
    expect(snapshot?.countsAsSpent).toBe(true);
    ledger.close();
  });

  it("releases a payment-rejected paid-fetch (definitive no-pay)", () => {
    const { ledger } = openLedger();
    ledger.recordPending(paidFetch(), "auto", "hash-1");
    ledger.recordFailed("req-fetch-0001", "payment-rejected", {
      code: 402,
      message: "offer changed",
    });
    const snapshot = ledger.getOutcome("req-fetch-0001");
    expect(snapshot?.state).toBe("failed");
    expect(snapshot?.countsAsSpent).toBe(false);
    ledger.close();
  });

  it("keeps a payment-transport-error ambiguous and counting", () => {
    const { ledger } = openLedger();
    ledger.recordPending(paidFetch(), "auto", "hash-1");
    ledger.recordAmbiguous("req-fetch-0001", "payment-transport-error");
    const snapshot = ledger.getOutcome("req-fetch-0001");
    expect(snapshot?.state).toBe("ambiguous");
    expect(snapshot?.countsAsSpent).toBe(true);
    // resolvable like any ambiguity
    ledger.recordResolved("req-fetch-0001", "not-spent", null, "cli-resolve");
    expect(ledger.getOutcome("req-fetch-0001")?.countsAsSpent).toBe(false);
    ledger.close();
  });

  it("refuses broadcast rows for paid-fetch and settled rows for on-chain kinds", () => {
    const { ledger } = openLedger();
    ledger.recordPending(paidFetch(), "auto", "hash-1");
    expect(() =>
      ledger.recordBroadcast("req-fetch-0001", "ab".repeat(32), [], null),
    ).toThrow(LedgerStateError);
    ledger.recordPending(topup(), "auto", "hash-1");
    expect(() => ledger.recordSettled("req-topup-0001", 200)).toThrow(LedgerStateError);
    ledger.close();
  });

  it("pins failure stages and ambiguity causes per kind (the verifier's last line)", () => {
    const { ledger } = openLedger();
    // payment-rejected is paid-fetch only; on-chain rows cannot claim it.
    ledger.recordPending(topup(), "auto", "hash-1");
    expect(() =>
      ledger.recordFailed("req-topup-0001", "payment-rejected", { message: "x" }),
    ).toThrow(LedgerStateError);
    // broadcast-transport-error is on-chain only; paid-fetch rows cannot claim it.
    ledger.recordPending(paidFetch(), "auto", "hash-1");
    expect(() =>
      ledger.recordAmbiguous("req-fetch-0001", "broadcast-transport-error"),
    ).toThrow(LedgerStateError);
    ledger.close();
  });

  it("owns the resolve-spent evidence rule per kind (txid required on-chain, forbidden off-chain)", () => {
    const { ledger } = openLedger();
    ledger.recordPending(paidFetch(), "auto", "hash-1");
    ledger.recordAmbiguous("req-fetch-0001", "payment-transport-error");
    // An off-chain row cannot resolve spent WITH a txid.
    expect(() =>
      ledger.recordResolved("req-fetch-0001", "spent", "ab".repeat(32), "cli-resolve"),
    ).toThrow(LedgerStateError);
    // An on-chain row cannot resolve spent WITHOUT a txid.
    ledger.recordPending(topup({ requestId: "req-topup-0001" }), "auto", "hash-1");
    ledger.recordAmbiguous("req-topup-0001", "broadcast-transport-error");
    expect(() =>
      ledger.recordResolved("req-topup-0001", "spent", null, "cli-resolve"),
    ).toThrow(LedgerStateError);
    ledger.close();
  });

  it("settled is terminal", () => {
    const { ledger } = openLedger();
    ledger.recordPending(paidFetch(), "auto", "hash-1");
    ledger.recordSettled("req-fetch-0001", 500);
    expect(() => ledger.recordSettled("req-fetch-0001", 200)).toThrow(LedgerStateError);
    expect(() =>
      ledger.recordAmbiguous("req-fetch-0001", "payment-transport-error"),
    ).toThrow(LedgerStateError);
    ledger.close();
  });

  it("replays paid-fetch rows across a reopen and recovers a pending tail as ambiguous", () => {
    const { ledger, dir } = openLedger();
    ledger.recordPending(paidFetch(), "auto", "hash-1");
    ledger.recordSettled("req-fetch-0001", 200);
    ledger.recordPending(paidFetch({ requestId: "req-fetch-0002" }), "auto", "hash-1");
    ledger.close();

    const reopened = SpendLedger.open(dir, { clock: () => new Date(clockMs) });
    expect(reopened.getOutcome("req-fetch-0001")?.state).toBe("settled");
    expect(reopened.getOutcome("req-fetch-0001")?.httpStatus).toBe(200);
    // The crashed-pending paid-fetch counts as spent until resolved.
    expect(reopened.recoveredRequestIds).toContain("req-fetch-0002");
    expect(reopened.getOutcome("req-fetch-0002")?.state).toBe("ambiguous");
    expect(reopened.getOutcome("req-fetch-0002")?.countsAsSpent).toBe(true);
    reopened.close();
  });
});

describe("aggregate split (no double-counting)", () => {
  it("keeps paid-fetch out of the on-chain aggregates and vice versa", () => {
    const { ledger } = openLedger();
    const dayMs = 24 * 60 * 60 * 1000;
    const now = new Date(clockMs);

    ledger.recordPending(topup({ amountSats: parseAmount("0.2") }), "auto", "hash-1");
    ledger.recordPending(
      paidFetch({ requestId: "req-fetch-0002", amountSats: parseAmount("0.003") }),
      "auto",
      "hash-1",
    );
    ledger.recordSettled("req-fetch-0002", 200);

    // On-chain aggregates see only the topup…
    expect(ledger.spentInWindowSats("VRSCTEST", dayMs, now)).toBe(parseAmount("0.2"));
    expect(ledger.totalSpentSats("VRSCTEST")).toBe(parseAmount("0.2"));
    expect(ledger.attemptsInWindow(dayMs, now)).toBe(1);
    // …and the paid-fetch aggregates only the payment.
    expect(ledger.paidFetchSpentInWindowSats("VRSCTEST", dayMs, now)).toBe(
      parseAmount("0.003"),
    );
    expect(
      ledger.serviceSpentInWindowSats("https://api.service.test", "VRSCTEST", dayMs, now),
    ).toBe(parseAmount("0.003"));
    expect(
      ledger.serviceSpentInWindowSats("https://other.test", "VRSCTEST", dayMs, now),
    ).toBe(0n);
    ledger.close();
  });

  it("does not move lastAttemptAt for paid-fetch rows (on-chain rate limits untouched)", () => {
    const { ledger } = openLedger();
    ledger.recordPending(topup(), "auto", "hash-1");
    const afterTopup = ledger.lastAttemptAt();
    clockMs += 60_000;
    ledger.recordPending(paidFetch({ requestId: "req-fetch-0009" }), "auto", "hash-1");
    expect(ledger.lastAttemptAt()).toEqual(afterTopup);
    ledger.close();
  });

  it("releases the daily service budget when a paid-fetch definitively fails", () => {
    const { ledger } = openLedger();
    const dayMs = 24 * 60 * 60 * 1000;
    ledger.recordPending(paidFetch(), "auto", "hash-1");
    ledger.recordFailed("req-fetch-0001", "payment-rejected", { message: "402 again" });
    expect(
      ledger.serviceSpentInWindowSats(
        "https://api.service.test",
        "VRSCTEST",
        dayMs,
        new Date(clockMs),
      ),
    ).toBe(0n);
    ledger.close();
  });
});
