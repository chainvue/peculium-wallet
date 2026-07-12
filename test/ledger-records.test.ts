import { describe, expect, it } from "vitest";

import {
  LedgerRecordError,
  parseLedgerLine,
  type LedgerRecord,
} from "../src/ledger/records.js";

const AT = "2026-07-12T12:00:00.000Z";
const TXID = "a".repeat(64);
const FINGERPRINT = "f".repeat(64);
const OUTPOINT = `${"c".repeat(64)}:0`;

const SAMPLES: LedgerRecord[] = [
  {
    v: 1,
    type: "pending",
    requestId: "req-topup-0001",
    fingerprint: FINGERPRINT,
    kind: "topup",
    recipientAddress: "RFacilitator1111111111111111111111",
    recipientName: "demo-facilitator",
    currency: "VRSCTEST",
    amountSats: "10000000",
    approval: "auto",
    policyHash: "policy-hash-1",
    at: AT,
  },
  {
    v: 1,
    type: "broadcast",
    requestId: "req-topup-0001",
    txid: TXID,
    spentOutpoints: [OUTPOINT],
    changeOutpoint: `${TXID}:1`,
    at: AT,
  },
  { v: 1, type: "confirmed", requestId: "req-topup-0001", txid: TXID, confirmations: 3, at: AT },
  {
    v: 1,
    type: "failed",
    requestId: "req-topup-0001",
    stage: "broadcast-rejected",
    error: { code: -26, message: "bad-txns-inputs-spent" },
    at: AT,
  },
  { v: 1, type: "ambiguous", requestId: "req-topup-0001", cause: "crash-recovery", at: AT },
  {
    v: 1,
    type: "resolved",
    requestId: "req-topup-0001",
    outcome: "spent",
    txid: TXID,
    by: "reconciler",
    at: AT,
  },
];

describe("ledger records", () => {
  it("round-trips every record type through JSON and parseLedgerLine", () => {
    for (const record of SAMPLES) {
      expect(parseLedgerLine(JSON.stringify(record))).toEqual(record);
    }
  });

  it("accepts a failed record without an error code and a null change outpoint", () => {
    expect(
      parseLedgerLine(
        JSON.stringify({
          v: 1,
          type: "failed",
          requestId: "req-send-00001",
          stage: "build",
          error: { message: "no spendable UTXOs" },
          at: AT,
        }),
      ).type,
    ).toBe("failed");
    expect(
      parseLedgerLine(
        JSON.stringify({
          v: 1,
          type: "broadcast",
          requestId: "req-send-00001",
          txid: TXID,
          spentOutpoints: [],
          changeOutpoint: null,
          at: AT,
        }),
      ).type,
    ).toBe("broadcast");
  });

  it("rejects non-JSON, unknown types and unknown keys (strict)", () => {
    expect(() => parseLedgerLine('{"v":1,"type":"pend')).toThrow(LedgerRecordError);
    expect(() => parseLedgerLine('{"v":1,"type":"opid-waiting"}')).toThrow(LedgerRecordError);
    const [pending] = SAMPLES;
    expect(() => parseLedgerLine(JSON.stringify({ ...pending, extra: 1 }))).toThrow(
      LedgerRecordError,
    );
  });

  it("rejects malformed amounts, txids, outpoints and confirmations", () => {
    const [pending, broadcast, confirmed] = SAMPLES;
    for (const amountSats of ["1.5", "-1", "007", ""]) {
      expect(() => parseLedgerLine(JSON.stringify({ ...pending, amountSats }))).toThrow(
        LedgerRecordError,
      );
    }
    expect(() => parseLedgerLine(JSON.stringify({ ...broadcast, txid: "abc" }))).toThrow(
      LedgerRecordError,
    );
    expect(() =>
      parseLedgerLine(JSON.stringify({ ...broadcast, spentOutpoints: ["no-colon"] })),
    ).toThrow(LedgerRecordError);
    expect(() => parseLedgerLine(JSON.stringify({ ...confirmed, confirmations: 0 }))).toThrow(
      LedgerRecordError,
    );
    expect(() => parseLedgerLine(JSON.stringify({ ...confirmed, confirmations: 1.5 }))).toThrow(
      LedgerRecordError,
    );
  });

  it("rejects a wrong schema version and a bad requestId", () => {
    const [pending] = SAMPLES;
    expect(() => parseLedgerLine(JSON.stringify({ ...pending, v: 2 }))).toThrow(LedgerRecordError);
    expect(() => parseLedgerLine(JSON.stringify({ ...pending, requestId: "x" }))).toThrow(
      LedgerRecordError,
    );
  });
});
