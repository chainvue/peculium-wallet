import { parseAmount } from "verus-rpc";
import { describe, expect, it } from "vitest";

import {
  amountStringSchema,
  intentFingerprint,
  rawSpendInputSchema,
  requestIdSchema,
} from "../src/intents.js";
import { send, topup } from "./helpers.js";

describe("intentFingerprint", () => {
  it("is a 64-char sha256 hex string", () => {
    expect(intentFingerprint(topup())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("identical transfers share a fingerprint regardless of requestId", () => {
    const a = topup({ requestId: "req-aaaaaaaa" });
    const b = topup({ requestId: "req-bbbbbbbb" });
    expect(intentFingerprint(a)).toBe(intentFingerprint(b));
  });

  it("free text (recipientName) never enters the fingerprint", () => {
    const a = topup({ recipientName: "demo-facilitator" });
    const b = topup({ recipientName: "totally different label" });
    expect(intentFingerprint(a)).toBe(intentFingerprint(b));
  });

  it("changes when kind changes", () => {
    const base = topup();
    const asSend = send({
      amountSats: base.amountSats,
      currency: base.currency,
      recipientAddress: base.recipientAddress,
      recipientName: base.recipientName,
    });
    expect(intentFingerprint(base)).not.toBe(intentFingerprint(asSend));
  });

  it("changes when the recipient address changes", () => {
    expect(intentFingerprint(topup({ recipientAddress: "ROther111" }))).not.toBe(
      intentFingerprint(topup()),
    );
  });

  it("changes when the currency changes", () => {
    expect(intentFingerprint(topup({ currency: "TOKEN" }))).not.toBe(
      intentFingerprint(topup()),
    );
  });

  it("changes when the amount changes by one satoshi", () => {
    const base = topup();
    expect(
      intentFingerprint(topup({ amountSats: base.amountSats + 1n })),
    ).not.toBe(intentFingerprint(base));
  });
});

describe("requestIdSchema", () => {
  it("accepts 8 and 64 character ids", () => {
    expect(requestIdSchema.safeParse("a".repeat(8)).success).toBe(true);
    expect(requestIdSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(requestIdSchema.safeParse("Req_1.2-3x").success).toBe(true);
  });

  it("rejects 7 and 65 character ids and foreign characters", () => {
    expect(requestIdSchema.safeParse("a".repeat(7)).success).toBe(false);
    expect(requestIdSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(requestIdSchema.safeParse("has space!").success).toBe(false);
    expect(requestIdSchema.safeParse("").success).toBe(false);
  });
});

describe("amountStringSchema", () => {
  it("accepts positive decimal strings up to 8 places", () => {
    expect(amountStringSchema.safeParse("0.5").success).toBe(true);
    expect(amountStringSchema.safeParse("10").success).toBe(true);
    expect(amountStringSchema.safeParse("0.00000001").success).toBe(true);
    expect(amountStringSchema.safeParse("1e-8").success).toBe(true);
  });

  it("rejects zero, negatives, >8 decimals and non-numbers", () => {
    expect(amountStringSchema.safeParse("0").success).toBe(false);
    expect(amountStringSchema.safeParse("-1").success).toBe(false);
    expect(amountStringSchema.safeParse("0.123456789").success).toBe(false);
    expect(amountStringSchema.safeParse("abc").success).toBe(false);
    expect(amountStringSchema.safeParse("").success).toBe(false);
  });
});

describe("rawSpendInputSchema", () => {
  const valid = {
    requestId: "req-12345678",
    amount: "0.5",
    currency: "VRSCTEST",
    recipient: "demo-facilitator",
  };

  it("accepts a valid raw money-tool input", () => {
    expect(rawSpendInputSchema.safeParse(valid).success).toBe(true);
  });

  it("is strict: unknown keys are rejected", () => {
    expect(rawSpendInputSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it("rejects a missing field", () => {
    const { recipient: _recipient, ...missing } = valid;
    expect(rawSpendInputSchema.safeParse(missing).success).toBe(false);
  });

  it("keeps the amount a string (no float ever)", () => {
    const parsed = rawSpendInputSchema.parse(valid);
    expect(parsed.amount).toBe("0.5");
    expect(parseAmount(parsed.amount)).toBe(50_000_000n);
  });
});
