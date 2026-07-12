// Property-style test: across hundreds of randomized intents (seeded PRNG,
// fully deterministic) no intent that exceeds ANY applicable cap — compiled
// hard cap, per-currency policy cap, active grant, or "currency not
// configured at all" — ever gets past the engine as auto OR confirm.
// The converse is asserted too: an intent inside every cap (with rate,
// dedupe and arming disabled by the fixture) is never denied, and an auto
// verdict only ever goes to a topup.

import { describe, expect, it } from "vitest";

import { evaluatePolicy } from "../src/policy/engine.js";
import { HARD_CAPS } from "../src/limits.js";
import type { SpendIntent } from "../src/intents.js";
import type { WalletState } from "../src/state.js";
import {
  FACILITATOR_ADDRESS,
  IDLE_STATE,
  isoAt,
  makeLedger,
  makePolicy,
  NOW,
  RECIPIENT_ADDRESS,
} from "./helpers.js";

/** Deterministic PRNG (mulberry32) so a failure is exactly reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface CapTriple {
  perTx: bigint;
  perDay: bigint;
  total: bigint;
}

// Mirrors the fixture policy in helpers.ts.
const POLICY_CAPS: Record<string, CapTriple> = {
  VRSCTEST: { perTx: 200_000_000n, perDay: 800_000_000n, total: 2_000_000_000n },
  TOKEN: { perTx: 10_000_000_000n, perDay: 50_000_000_000n, total: 100_000_000_000n },
};

// Amount/spend ranges chosen to straddle every cap generously.
const AMOUNT_RANGE: Record<string, number> = {
  VRSCTEST: 3_000_000_000, // up to 30 coins vs a 10-coin hard cap
  TOKEN: 150_000_000_000, // up to 1500 coins vs a 100-coin per-tx cap
  GHOST: 1_000_000_000,
};

describe("engine — property: cap excess always denies", () => {
  it("no randomized intent above any applicable cap passes (500 cases)", () => {
    const rand = mulberry32(0x5eed);
    const randomSats = (max: number): bigint => 1n + BigInt(Math.floor(rand() * max));
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(rand() * items.length)];
      if (item === undefined) throw new Error("unreachable");
      return item;
    };

    const policy = makePolicy({
      armRequired: false,
      rate: { maxSendsPerHour: 60, minSecondsBetweenSends: 0, dedupeWindowSeconds: 0 },
    });

    for (let i = 0; i < 500; i++) {
      const currency = pick(["VRSCTEST", "TOKEN", "GHOST"] as const);
      const kind = rand() < 0.5 ? ("topup" as const) : ("send" as const);
      const amountSats = randomSats(AMOUNT_RANGE[currency] ?? 1);
      const spentDay = rand() < 0.5 ? randomSats(AMOUNT_RANGE[currency] ?? 1) : 0n;
      const spentTotal = spentDay + (rand() < 0.5 ? randomSats(AMOUNT_RANGE[currency] ?? 1) : 0n);

      const intent: SpendIntent =
        kind === "topup"
          ? {
              kind,
              requestId: `req-${String(i).padStart(8, "0")}`,
              amountSats,
              currency,
              recipientAddress: FACILITATOR_ADDRESS,
              recipientName: "demo-facilitator",
            }
          : {
              kind,
              requestId: `req-${String(i).padStart(8, "0")}`,
              amountSats,
              currency,
              recipientAddress: RECIPIENT_ADDRESS,
              recipientName: "alice",
            };

      const grantRemaining = rand() < 0.33 ? randomSats(AMOUNT_RANGE[currency] ?? 1) : null;
      const state: WalletState =
        grantRemaining === null
          ? IDLE_STATE
          : {
              schemaVersion: 1,
              armedUntil: null,
              grant: { currency, remainingSats: grantRemaining, expiresAt: isoAt(3_600_000) },
            };

      const ledger = makeLedger({
        spentInWindowSats: (c) => (c === currency ? spentDay : 0n),
        totalSpentSats: (c) => (c === currency ? spentTotal : 0n),
      });

      // Independent mirror of "does this exceed ANY applicable cap?".
      let exceeds = false;
      if (currency === "VRSCTEST") {
        exceeds ||=
          amountSats > HARD_CAPS.maxPerTxSats ||
          spentDay + amountSats > HARD_CAPS.maxPerDaySats ||
          spentTotal + amountSats > HARD_CAPS.maxTotalSats;
      }
      const caps = POLICY_CAPS[currency];
      if (caps === undefined) {
        exceeds = true; // unconfigured currency: nothing may pass
      } else {
        exceeds ||=
          amountSats > caps.perTx ||
          spentDay + amountSats > caps.perDay ||
          spentTotal + amountSats > caps.total;
      }
      if (grantRemaining !== null && amountSats > grantRemaining) {
        exceeds = true;
      }

      const decision = evaluatePolicy(intent, policy, ledger, state, NOW);
      const context = `case ${i}: ${kind} ${amountSats} ${currency} day=${spentDay} total=${spentTotal} grant=${grantRemaining ?? "none"}`;

      if (exceeds) {
        expect(decision.verdict, `${context} must deny`).toBe("deny");
      } else {
        expect(decision.verdict, `${context} must not deny`).not.toBe("deny");
      }
      if (decision.verdict === "auto") {
        expect(intent.kind, `${context} — only topups may be auto`).toBe("topup");
      }
    }
  });
});
