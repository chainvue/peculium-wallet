import { parseAmount } from "@chainvue/verus-rpc";
import { describe, expect, it } from "vitest";

import { intentFingerprint } from "../src/intents.js";
import { evaluatePolicy, type Decision } from "../src/policy/engine.js";
import type { SupportedChain } from "../src/limits.js";
import type { WalletState } from "../src/state.js";
import {
  FACILITATOR_ADDRESS,
  IDLE_STATE,
  isoAt,
  makeLedger,
  makePolicy,
  NATIVE_AT_HARD_CAPS,
  NATIVE_AT_STARTER_CAPS,
  NOW,
  RECIPIENT_ADDRESS,
  send,
  topup,
} from "./helpers.js";

const SAT = 1n;

function expectDeny(decision: Decision, reasonCode: string): void {
  expect(decision.verdict).toBe("deny");
  if (decision.verdict === "deny") {
    expect(decision.reasonCode).toBe(reasonCode);
    expect(decision.humanText.length).toBeGreaterThan(0);
  }
}

function expectConfirm(decision: Decision, reason: string): void {
  expect(decision).toEqual({ verdict: "confirm", reason });
}

describe("engine — network pin", () => {
  it("denies a policy for a chain this build does not support", () => {
    const policy = { ...makePolicy(), network: "VRSC" as SupportedChain };
    expectDeny(
      evaluatePolicy(send(), policy, makeLedger(), IDLE_STATE, NOW),
      "network-not-supported",
    );
  });
});

describe("engine — intent shape re-validation", () => {
  it("denies zero and negative amounts", () => {
    for (const amountSats of [0n, -1n]) {
      expectDeny(
        evaluatePolicy(send({ amountSats }), makePolicy(), makeLedger(), IDLE_STATE, NOW),
        "invalid-intent",
      );
    }
  });

  it("denies malformed requestIds", () => {
    for (const requestId of ["short", "a".repeat(65), "white space!"]) {
      expectDeny(
        evaluatePolicy(send({ requestId }), makePolicy(), makeLedger(), IDLE_STATE, NOW),
        "invalid-intent",
      );
    }
  });

  it("denies empty currency, address or name", () => {
    for (const broken of [
      send({ currency: "" }),
      send({ recipientAddress: "" }),
      send({ recipientName: "" }),
    ]) {
      expectDeny(
        evaluatePolicy(broken, makePolicy(), makeLedger(), IDLE_STATE, NOW),
        "invalid-intent",
      );
    }
  });

  it("shape is checked before caps (ordering)", () => {
    const decision = evaluatePolicy(
      send({ requestId: "nope", amountSats: parseAmount("999") }),
      makePolicy(),
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expectDeny(decision, "invalid-intent");
  });
});

describe("engine — compiled hard caps (native currency)", () => {
  const policy = makePolicy({ currencies: NATIVE_AT_HARD_CAPS });

  it("per-tx: exactly 10 passes, 10 + 1 sat is denied", () => {
    const at = evaluatePolicy(
      send({ amountSats: parseAmount("10") }),
      policy,
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expectConfirm(at, "send-always-confirms");
    const over = evaluatePolicy(
      send({ amountSats: parseAmount("10") + SAT }),
      policy,
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expectDeny(over, "hard-cap-per-tx-exceeded");
  });

  it("per-day (trailing 24h): landing exactly on 50 passes, one sat over is denied", () => {
    const amount = parseAmount("10");
    const at = evaluatePolicy(
      send({ amountSats: amount }),
      policy,
      makeLedger({ spentInWindowSats: () => parseAmount("40") }),
      IDLE_STATE,
      NOW,
    );
    expectConfirm(at, "send-always-confirms");
    const over = evaluatePolicy(
      send({ amountSats: amount }),
      policy,
      makeLedger({ spentInWindowSats: () => parseAmount("40") + SAT }),
      IDLE_STATE,
      NOW,
    );
    expectDeny(over, "hard-cap-per-day-exceeded");
  });

  it("total: landing exactly on 250 passes, one sat over is denied", () => {
    const amount = parseAmount("10");
    const at = evaluatePolicy(
      send({ amountSats: amount }),
      policy,
      makeLedger({ totalSpentSats: () => parseAmount("240") }),
      IDLE_STATE,
      NOW,
    );
    expectConfirm(at, "send-always-confirms");
    const over = evaluatePolicy(
      send({ amountSats: amount }),
      policy,
      makeLedger({ totalSpentSats: () => parseAmount("240") + SAT }),
      IDLE_STATE,
      NOW,
    );
    expectDeny(over, "hard-cap-total-exceeded");
  });

  it("hard caps bind before recipient checks (a tampered policy cannot reorder)", () => {
    const decision = evaluatePolicy(
      send({ amountSats: parseAmount("10") + SAT, recipientAddress: "RUnknown1" }),
      policy,
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expectDeny(decision, "hard-cap-per-tx-exceeded");
  });

  it("non-native currencies are NOT subject to the compiled caps", () => {
    const decision = evaluatePolicy(
      send({ currency: "TOKEN", amountSats: parseAmount("100") }),
      policy,
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expectConfirm(decision, "send-always-confirms");
  });
});

describe("engine — starter-mode hard caps", () => {
  const policy = makePolicy({
    addressMode: "starter-r-address",
    currencies: NATIVE_AT_STARTER_CAPS,
  });

  it("per-tx: exactly 1 passes, 1 + 1 sat is denied", () => {
    expectConfirm(
      evaluatePolicy(send({ amountSats: parseAmount("1") }), policy, makeLedger(), IDLE_STATE, NOW),
      "send-always-confirms",
    );
    expectDeny(
      evaluatePolicy(
        send({ amountSats: parseAmount("1") + SAT }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "hard-cap-per-tx-exceeded",
    );
  });

  it("per-day: exactly 5 passes, one sat over is denied", () => {
    const amount = parseAmount("1");
    expectConfirm(
      evaluatePolicy(
        send({ amountSats: amount }),
        policy,
        makeLedger({ spentInWindowSats: () => parseAmount("4") }),
        IDLE_STATE,
        NOW,
      ),
      "send-always-confirms",
    );
    expectDeny(
      evaluatePolicy(
        send({ amountSats: amount }),
        policy,
        makeLedger({ spentInWindowSats: () => parseAmount("4") + SAT }),
        IDLE_STATE,
        NOW,
      ),
      "hard-cap-per-day-exceeded",
    );
  });

  it("total: exactly 25 passes, one sat over is denied", () => {
    const amount = parseAmount("1");
    expectConfirm(
      evaluatePolicy(
        send({ amountSats: amount }),
        policy,
        makeLedger({ totalSpentSats: () => parseAmount("24") }),
        IDLE_STATE,
        NOW,
      ),
      "send-always-confirms",
    );
    expectDeny(
      evaluatePolicy(
        send({ amountSats: amount }),
        policy,
        makeLedger({ totalSpentSats: () => parseAmount("24") + SAT }),
        IDLE_STATE,
        NOW,
      ),
      "hard-cap-total-exceeded",
    );
  });
});

describe("engine — currency configuration (fail closed)", () => {
  it("denies any intent in a currency without a cap entry", () => {
    expectDeny(
      evaluatePolicy(send({ currency: "GHOST" }), makePolicy(), makeLedger(), IDLE_STATE, NOW),
      "currency-not-configured",
    );
  });

  it("currency check precedes recipient resolution (ordering)", () => {
    expectDeny(
      evaluatePolicy(
        send({ currency: "GHOST", recipientAddress: "RUnknown1", recipientName: "who" }),
        makePolicy(),
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "currency-not-configured",
    );
  });
});

describe("engine — recipient resolution", () => {
  it("denies a topup to an address that is not an allowlisted facilitator", () => {
    expectDeny(
      evaluatePolicy(
        topup({ recipientAddress: "RUnknown1", recipientName: "who" }),
        makePolicy(),
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "facilitator-not-listed",
    );
  });

  it("a recipient-list entry does not satisfy a topup (lists are not interchangeable)", () => {
    expectDeny(
      evaluatePolicy(
        topup({ recipientAddress: RECIPIENT_ADDRESS, recipientName: "alice" }),
        makePolicy(),
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "facilitator-not-listed",
    );
  });

  it("denies a send to an address that is not an allowlisted recipient", () => {
    expectDeny(
      evaluatePolicy(
        send({ recipientAddress: FACILITATOR_ADDRESS, recipientName: "demo-facilitator" }),
        makePolicy(),
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "recipient-not-listed",
    );
  });

  it("denies a (name, address) pair that does not match the allowlist entry", () => {
    expectDeny(
      evaluatePolicy(
        send({ recipientAddress: RECIPIENT_ADDRESS, recipientName: "bob" }),
        makePolicy(),
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "recipient-not-listed",
    );
    expectDeny(
      evaluatePolicy(
        topup({ recipientName: "someone-else" }),
        makePolicy(),
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "facilitator-not-listed",
    );
  });
});

describe("engine — arm window", () => {
  const policy = makePolicy({ armRequired: true });

  it("denies when disarmed and when armedUntil is in the past", () => {
    expectDeny(evaluatePolicy(send(), policy, makeLedger(), IDLE_STATE, NOW), "not-armed");
    const past: WalletState = { ...IDLE_STATE, armedUntil: isoAt(-1) };
    expectDeny(evaluatePolicy(send(), policy, makeLedger(), past, NOW), "not-armed");
  });

  it("armedUntil exactly at now counts as expired (boundary)", () => {
    const state: WalletState = { ...IDLE_STATE, armedUntil: isoAt(0) };
    expectDeny(evaluatePolicy(send(), policy, makeLedger(), state, NOW), "not-armed");
  });

  it("passes while armed", () => {
    const state: WalletState = { ...IDLE_STATE, armedUntil: isoAt(60_000) };
    expectConfirm(evaluatePolicy(send(), policy, makeLedger(), state, NOW), "send-always-confirms");
  });

  it("armRequired false never requires arming", () => {
    expectConfirm(
      evaluatePolicy(send(), makePolicy(), makeLedger(), IDLE_STATE, NOW),
      "send-always-confirms",
    );
  });

  it("arm check precedes cap checks (ordering)", () => {
    expectDeny(
      evaluatePolicy(send({ amountSats: parseAmount("5") }), policy, makeLedger(), IDLE_STATE, NOW),
      "not-armed",
    );
  });
});

describe("engine — grant", () => {
  const grantState = (remaining: string, expiresOffsetMs: number, currency = "VRSCTEST"): WalletState => ({
    schemaVersion: 1,
    armedUntil: null,
    grant: {
      currency,
      remainingSats: parseAmount(remaining),
      expiresAt: isoAt(expiresOffsetMs),
    },
  });

  it("depletion boundary: amount equal to the remaining grant passes, one sat over is denied", () => {
    const state = grantState("1", 3_600_000);
    expectConfirm(
      evaluatePolicy(send({ amountSats: parseAmount("1") }), makePolicy(), makeLedger(), state, NOW),
      "send-always-confirms",
    );
    expectDeny(
      evaluatePolicy(
        send({ amountSats: parseAmount("1") + SAT }),
        makePolicy(),
        makeLedger(),
        state,
        NOW,
      ),
      "grant-exceeded",
    );
  });

  it("denies a currency mismatch against an active grant", () => {
    const state = grantState("100", 3_600_000, "TOKEN");
    expectDeny(
      evaluatePolicy(send({ currency: "VRSCTEST" }), makePolicy(), makeLedger(), state, NOW),
      "grant-currency-mismatch",
    );
  });

  it("an expired grant is no grant — expiry boundary at exactly now", () => {
    // Amount larger than the (expired) grant remaining: must pass.
    for (const offset of [0, -1]) {
      const state = grantState("0.00000001", offset);
      expectConfirm(
        evaluatePolicy(
          send({ amountSats: parseAmount("1") }),
          makePolicy(),
          makeLedger(),
          state,
          NOW,
        ),
        "send-always-confirms",
      );
    }
  });

  it("grant is checked before the per-currency caps (ordering)", () => {
    // 3 VRSCTEST is over the policy per-tx cap of 2, but the grant denies first.
    const state = grantState("0.5", 3_600_000);
    expectDeny(
      evaluatePolicy(send({ amountSats: parseAmount("3") }), makePolicy(), makeLedger(), state, NOW),
      "grant-exceeded",
    );
  });
});

describe("engine — per-currency policy caps", () => {
  it("per-tx boundary for a non-native token: at cap passes, cap + 1 sat is denied", () => {
    const at = send({ currency: "TOKEN", amountSats: parseAmount("100") });
    expectConfirm(
      evaluatePolicy(at, makePolicy(), makeLedger(), IDLE_STATE, NOW),
      "send-always-confirms",
    );
    const over = send({ currency: "TOKEN", amountSats: parseAmount("100") + SAT });
    expectDeny(
      evaluatePolicy(over, makePolicy(), makeLedger(), IDLE_STATE, NOW),
      "per-tx-cap-exceeded",
    );
  });

  it("daily boundary (trailing 24h)", () => {
    const intent = send({ currency: "TOKEN", amountSats: parseAmount("100") });
    const at = makeLedger({
      spentInWindowSats: (currency) => (currency === "TOKEN" ? parseAmount("400") : 0n),
    });
    expectConfirm(
      evaluatePolicy(intent, makePolicy(), at, IDLE_STATE, NOW),
      "send-always-confirms",
    );
    const over = makeLedger({
      spentInWindowSats: (currency) => (currency === "TOKEN" ? parseAmount("400") + SAT : 0n),
    });
    expectDeny(evaluatePolicy(intent, makePolicy(), over, IDLE_STATE, NOW), "daily-cap-exceeded");
  });

  it("total boundary", () => {
    const intent = send({ currency: "TOKEN", amountSats: parseAmount("100") });
    const at = makeLedger({
      totalSpentSats: (currency) => (currency === "TOKEN" ? parseAmount("900") : 0n),
    });
    expectConfirm(
      evaluatePolicy(intent, makePolicy(), at, IDLE_STATE, NOW),
      "send-always-confirms",
    );
    const over = makeLedger({
      totalSpentSats: (currency) => (currency === "TOKEN" ? parseAmount("900") + SAT : 0n),
    });
    expectDeny(evaluatePolicy(intent, makePolicy(), over, IDLE_STATE, NOW), "total-cap-exceeded");
  });

  it("native per-tx cap below the hard cap denies with the policy code", () => {
    // Policy per-tx is 2, hard cap is 10: 3 must be a policy deny, not a hard-cap deny.
    expectDeny(
      evaluatePolicy(
        send({ amountSats: parseAmount("3") }),
        makePolicy(),
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "per-tx-cap-exceeded",
    );
  });

  it("aggregate isolation: spend in currency A never counts against currency B", () => {
    // VRSCTEST is fully exhausted for the day and lifetime; TOKEN is untouched.
    const ledger = makeLedger({
      spentInWindowSats: (currency) => (currency === "VRSCTEST" ? parseAmount("8") : 0n),
      totalSpentSats: (currency) => (currency === "VRSCTEST" ? parseAmount("20") : 0n),
    });
    expectConfirm(
      evaluatePolicy(
        send({ currency: "TOKEN", amountSats: parseAmount("50") }),
        makePolicy(),
        ledger,
        IDLE_STATE,
        NOW,
      ),
      "send-always-confirms",
    );
    // And the exhausted currency itself is denied.
    expectDeny(
      evaluatePolicy(send(), makePolicy(), ledger, IDLE_STATE, NOW),
      "daily-cap-exceeded",
    );
  });

  it("queries the ledger with the intent's currency and a 24h window", () => {
    const seen: Array<{ currency: string; windowMs: number }> = [];
    const ledger = makeLedger({
      spentInWindowSats: (currency, windowMs) => {
        seen.push({ currency, windowMs });
        return 0n;
      },
    });
    evaluatePolicy(
      send({ currency: "TOKEN", amountSats: parseAmount("1") }),
      makePolicy(),
      ledger,
      IDLE_STATE,
      NOW,
    );
    expect(seen).toEqual([{ currency: "TOKEN", windowMs: 24 * 60 * 60 * 1000 }]);
  });
});

describe("engine — rate limits", () => {
  it("trips at exactly maxSendsPerHour attempts in the trailing hour", () => {
    const under = makeLedger({ attemptsInWindow: () => 9 });
    expectConfirm(
      evaluatePolicy(send(), makePolicy(), under, IDLE_STATE, NOW),
      "send-always-confirms",
    );
    const at = makeLedger({ attemptsInWindow: () => 10 });
    expectDeny(evaluatePolicy(send(), makePolicy(), at, IDLE_STATE, NOW), "rate-limit-exceeded");
  });

  it("uses a one-hour window for attempts", () => {
    let seenWindow = -1;
    const ledger = makeLedger({
      attemptsInWindow: (windowMs) => {
        seenWindow = windowMs;
        return 0;
      },
    });
    evaluatePolicy(send(), makePolicy(), ledger, IDLE_STATE, NOW);
    expect(seenWindow).toBe(60 * 60 * 1000);
  });

  it("min-interval boundary: exactly minSecondsBetweenSends elapsed passes, one ms less denies", () => {
    const policy = makePolicy({
      rate: { maxSendsPerHour: 10, minSecondsBetweenSends: 30, dedupeWindowSeconds: 0 },
    });
    const atBoundary = makeLedger({ lastAttemptAt: () => new Date(NOW.getTime() - 30_000) });
    expectConfirm(
      evaluatePolicy(send(), policy, atBoundary, IDLE_STATE, NOW),
      "send-always-confirms",
    );
    const tooSoon = makeLedger({ lastAttemptAt: () => new Date(NOW.getTime() - 29_999) });
    expectDeny(evaluatePolicy(send(), policy, tooSoon, IDLE_STATE, NOW), "min-interval-not-elapsed");
  });

  it("minSecondsBetweenSends of 0 never blocks", () => {
    const ledger = makeLedger({ lastAttemptAt: () => NOW });
    expectConfirm(
      evaluatePolicy(send(), makePolicy(), ledger, IDLE_STATE, NOW),
      "send-always-confirms",
    );
  });

  it("rate is checked after caps and before dedupe (ordering)", () => {
    const ledger = makeLedger({
      attemptsInWindow: () => 10,
      hasFingerprintInWindow: () => true,
    });
    expectDeny(evaluatePolicy(send(), makePolicy(), ledger, IDLE_STATE, NOW), "rate-limit-exceeded");
    expectDeny(
      evaluatePolicy(
        send({ amountSats: parseAmount("3") }),
        makePolicy(),
        makeLedger({ attemptsInWindow: () => 10 }),
        IDLE_STATE,
        NOW,
      ),
      "per-tx-cap-exceeded",
    );
  });
});

describe("engine — fingerprint dedupe", () => {
  it("denies an identical transfer inside the dedupe window", () => {
    const intent = send();
    let seen: { fingerprint: string; windowMs: number } | undefined;
    const ledger = makeLedger({
      hasFingerprintInWindow: (fingerprint, windowMs) => {
        seen = { fingerprint, windowMs };
        return true;
      },
    });
    expectDeny(evaluatePolicy(intent, makePolicy(), ledger, IDLE_STATE, NOW), "duplicate-intent");
    expect(seen).toEqual({
      fingerprint: intentFingerprint(intent),
      windowMs: 600_000,
    });
  });

  it("passes when the ledger reports no duplicate (outside the window)", () => {
    expectConfirm(
      evaluatePolicy(send(), makePolicy(), makeLedger(), IDLE_STATE, NOW),
      "send-always-confirms",
    );
  });

  it("a dedupe window of 0 disables the check entirely", () => {
    const policy = makePolicy({
      rate: { maxSendsPerHour: 10, minSecondsBetweenSends: 0, dedupeWindowSeconds: 0 },
    });
    let called = false;
    const ledger = makeLedger({
      hasFingerprintInWindow: () => {
        called = true;
        return true;
      },
    });
    expectConfirm(evaluatePolicy(send(), policy, ledger, IDLE_STATE, NOW), "send-always-confirms");
    expect(called).toBe(false);
  });
});

describe("engine — tier (auto vs confirm)", () => {
  it("send is NEVER auto, even well within every budget", () => {
    const decision = evaluatePolicy(
      send({ amountSats: SAT }),
      makePolicy(),
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expectConfirm(decision, "send-always-confirms");
  });

  it("topup within the facilitator budget with autoApprove is auto", () => {
    const decision = evaluatePolicy(
      topup({ amountSats: parseAmount("0.5") }),
      makePolicy(),
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expect(decision).toEqual({ verdict: "auto" });
  });

  it("facilitator per-tx boundary: at cap auto, one sat over confirms (NOT denies)", () => {
    expect(
      evaluatePolicy(
        topup({ amountSats: parseAmount("0.5") }),
        makePolicy(),
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
    ).toEqual({ verdict: "auto" });
    expectConfirm(
      evaluatePolicy(
        topup({ amountSats: parseAmount("0.5") + SAT }),
        makePolicy(),
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "facilitator-per-tx-exceeded",
    );
  });

  it("facilitator per-day boundary: landing exactly on the budget is auto, one sat over confirms", () => {
    const amount = parseAmount("0.5");
    const at = makeLedger({ facilitatorSpentInWindowSats: () => parseAmount("1.5") });
    expect(
      evaluatePolicy(topup({ amountSats: amount }), makePolicy(), at, IDLE_STATE, NOW),
    ).toEqual({ verdict: "auto" });
    const over = makeLedger({
      facilitatorSpentInWindowSats: () => parseAmount("1.5") + SAT,
    });
    expectConfirm(
      evaluatePolicy(topup({ amountSats: amount }), makePolicy(), over, IDLE_STATE, NOW),
      "facilitator-per-day-exceeded",
    );
  });

  it("facilitator daily budget is queried per facilitator address and currency", () => {
    const seen: Array<{ address: string; currency: string; windowMs: number }> = [];
    const ledger = makeLedger({
      facilitatorSpentInWindowSats: (address, currency, windowMs) => {
        seen.push({ address, currency, windowMs });
        return 0n;
      },
    });
    evaluatePolicy(topup(), makePolicy(), ledger, IDLE_STATE, NOW);
    expect(seen).toEqual([
      { address: FACILITATOR_ADDRESS, currency: "VRSCTEST", windowMs: 24 * 60 * 60 * 1000 },
    ]);
  });

  it("autoApprove:false facilitator always confirms", () => {
    const policy = makePolicy({
      facilitators: [
        {
          name: "demo-facilitator",
          address: FACILITATOR_ADDRESS,
          currency: "VRSCTEST",
          maxPerTx: "0.5",
          maxPerDay: "2",
          autoApprove: false,
        },
      ],
    });
    expectConfirm(
      evaluatePolicy(topup({ amountSats: SAT }), policy, makeLedger(), IDLE_STATE, NOW),
      "facilitator-not-auto-approve",
    );
  });

  it("topup in a configured currency the facilitator has no entry for confirms", () => {
    const decision = evaluatePolicy(
      topup({ currency: "TOKEN", amountSats: parseAmount("1") }),
      makePolicy(),
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expectConfirm(decision, "facilitator-currency-mismatch");
  });

  it("a facilitator with entries in two currencies can auto-approve both", () => {
    const policy = makePolicy({
      facilitators: [
        {
          name: "demo-facilitator",
          address: FACILITATOR_ADDRESS,
          currency: "VRSCTEST",
          maxPerTx: "0.5",
          maxPerDay: "2",
          autoApprove: true,
        },
        {
          name: "demo-facilitator",
          address: FACILITATOR_ADDRESS,
          currency: "TOKEN",
          maxPerTx: "10",
          maxPerDay: "50",
          autoApprove: true,
        },
      ],
    });
    expect(
      evaluatePolicy(
        topup({ currency: "TOKEN", amountSats: parseAmount("10") }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
    ).toEqual({ verdict: "auto" });
  });

  it("topup over the facilitator budget but under global caps confirms, never denies", () => {
    // 1 VRSCTEST: over the 0.5 facilitator per-tx budget, under the
    // 2 policy per-tx cap and the 10 hard cap.
    const decision = evaluatePolicy(
      topup({ amountSats: parseAmount("1") }),
      makePolicy(),
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expectConfirm(decision, "facilitator-per-tx-exceeded");
  });
});
