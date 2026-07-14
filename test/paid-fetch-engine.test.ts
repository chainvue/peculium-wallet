// evaluatePaidFetch — the paid-fetch price gate. Same discipline as the
// on-chain engine tests: pure inputs, fixed clock, boundaries exercised at
// cap and cap+1 sat, every deny code reachable, tier decided last.

import { parseAmount } from "@chainvue/verus-rpc";
import { describe, expect, it } from "vitest";

import { evaluatePaidFetch } from "../src/policy/engine.js";
import {
  FACILITATOR_API_URL,
  IDLE_STATE,
  isoAt,
  makeLedger,
  makePolicyWithService,
  NOW,
  paidFetch,
  SERVICE_ORIGIN,
} from "./helpers.js";

const policy = makePolicyWithService();

function expectDeny(decision: ReturnType<typeof evaluatePaidFetch>, code: string): void {
  expect(decision.verdict).toBe("deny");
  if (decision.verdict === "deny") {
    expect(decision.reasonCode).toBe(code);
  }
}

describe("evaluatePaidFetch — allow path", () => {
  it("auto-approves an in-budget offer for an auto-approve service", () => {
    const decision = evaluatePaidFetch(paidFetch(), policy, makeLedger(), IDLE_STATE, NOW);
    expect(decision).toEqual({ verdict: "auto" });
  });

  it("allows a price exactly at the per-call cap (inclusive)", () => {
    const decision = evaluatePaidFetch(
      paidFetch({ amountSats: parseAmount("0.01") }),
      policy,
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expect(decision).toEqual({ verdict: "auto" });
  });

  it("allows filling the daily budget to exactly the cap", () => {
    const ledger = makeLedger({
      serviceSpentInWindowSats: () => parseAmount("0.04"),
    });
    const decision = evaluatePaidFetch(
      paidFetch({ amountSats: parseAmount("0.01") }),
      policy,
      ledger,
      IDLE_STATE,
      NOW,
    );
    expect(decision).toEqual({ verdict: "auto" });
  });
});

describe("evaluatePaidFetch — intent shape", () => {
  it("denies a non-positive offered price", () => {
    expectDeny(
      evaluatePaidFetch(paidFetch({ amountSats: 0n }), policy, makeLedger(), IDLE_STATE, NOW),
      "invalid-intent",
    );
  });

  it("denies a malformed requestId", () => {
    expectDeny(
      evaluatePaidFetch(paidFetch({ requestId: "x" }), policy, makeLedger(), IDLE_STATE, NOW),
      "invalid-intent",
    );
  });

  it("denies a path that does not start with /", () => {
    expectDeny(
      evaluatePaidFetch(paidFetch({ path: "v1/data" }), policy, makeLedger(), IDLE_STATE, NOW),
      "invalid-intent",
    );
  });
});

describe("evaluatePaidFetch — allowlist and offer pins", () => {
  it("denies an unlisted service name", () => {
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ recipientName: "mallory-api" }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "service-not-listed",
    );
  });

  it("denies a listed name whose origin does not match", () => {
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ recipientAddress: "https://evil.example.test" }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "service-not-listed",
    );
  });

  it("denies an offer on a different network", () => {
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ offerNetwork: "vrsc" }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "offer-network-mismatch",
    );
  });

  it("denies a protocol-invalid uppercase network id (only the wire form matches)", () => {
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ offerNetwork: "VRSCTEST" }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "offer-network-mismatch",
    );
  });

  it("denies an offer priced in a currency the service is not configured for", () => {
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ currency: "TOKEN" }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "offer-currency-mismatch",
    );
  });

  it("denies an offer binding the payment to a foreign domain (replay protection)", () => {
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ canonicalDomain: "other-service.test" }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "offer-domain-mismatch",
    );
  });

  it("accepts a canonicalDomain that includes the port", () => {
    const withPort = makePolicyWithService({
      facilitators: [
        {
          name: "demo-facilitator",
          address: "RFacilitator1111111111111111111111",
          currency: "VRSCTEST",
          maxPerTx: "0.5",
          maxPerDay: "2",
          autoApprove: true,
          apiUrl: FACILITATOR_API_URL,
        },
      ],
      services: [
        {
          name: "demo-api",
          origin: "http://127.0.0.1:3200",
          facilitator: "demo-facilitator",
          currency: "VRSCTEST",
          maxPricePerCall: "0.01",
          maxPerDay: "0.05",
          autoApprove: true,
        },
      ],
    });
    const decision = evaluatePaidFetch(
      paidFetch({
        recipientAddress: "http://127.0.0.1:3200",
        canonicalDomain: "127.0.0.1:3200",
      }),
      withPort,
      makeLedger(),
      IDLE_STATE,
      NOW,
    );
    expect(decision).toEqual({ verdict: "auto" });
  });

  it("denies an offer clearing through a different facilitator than configured", () => {
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ offerFacilitator: "https://attacker-bank.test" }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "offer-facilitator-mismatch",
    );
  });
});

describe("evaluatePaidFetch — caps", () => {
  it("denies one sat over the per-call price cap", () => {
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ amountSats: parseAmount("0.01") + 1n }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "service-price-cap-exceeded",
    );
  });

  it("denies when the daily budget would be exceeded by one sat", () => {
    const ledger = makeLedger({
      serviceSpentInWindowSats: () => parseAmount("0.04") + 1n,
    });
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ amountSats: parseAmount("0.01") }),
        policy,
        ledger,
        IDLE_STATE,
        NOW,
      ),
      "service-daily-cap-exceeded",
    );
  });

  it("consults the SERVICE aggregate, not the on-chain ones", () => {
    // Heavy on-chain spending must not throttle paid-fetch (separate pools).
    const ledger = makeLedger({
      spentInWindowSats: () => parseAmount("100"),
      totalSpentSats: () => parseAmount("1000"),
      attemptsInWindow: () => 999,
    });
    const decision = evaluatePaidFetch(paidFetch(), policy, ledger, IDLE_STATE, NOW);
    expect(decision).toEqual({ verdict: "auto" });
  });
});

describe("evaluatePaidFetch — compiled hard caps (native currency)", () => {
  // The fixture policy is verusid mode: per-call 1, per-day 25. Configure a
  // permissive service cap... impossible: parsePolicy refuses. The hard cap
  // binds through the ENGINE when the ledger already carries spend.
  it("denies when the compiled 24h paid-fetch ceiling would be exceeded", () => {
    const ledger = makeLedger({
      // Policy-level service budget has plenty of headroom in this scenario;
      // the WALLET-WIDE hard cap is what trips.
      paidFetchSpentInWindowSats: () => parseAmount("25"),
      serviceSpentInWindowSats: () => 0n,
    });
    expectDeny(
      evaluatePaidFetch(paidFetch(), policy, ledger, IDLE_STATE, NOW),
      "paid-fetch-hard-cap-per-day-exceeded",
    );
  });

  it("denies a single offer above the compiled per-call ceiling before any policy lookup", () => {
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ amountSats: parseAmount("1") + 1n, recipientName: "not-even-listed" }),
        policy,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "paid-fetch-hard-cap-per-call-exceeded",
    );
  });

  it("applies the tighter starter-mode ceiling", () => {
    const starter = makePolicyWithService({
      addressMode: "starter-r-address",
      currencies: [
        { currency: "VRSCTEST", maxPerTx: "1", maxPerDay: "5", maxTotal: "25" },
        { currency: "TOKEN", maxPerTx: "100", maxPerDay: "500", maxTotal: "1000" },
      ],
    });
    expectDeny(
      evaluatePaidFetch(
        paidFetch({ amountSats: parseAmount("0.25") + 1n }),
        starter,
        makeLedger(),
        IDLE_STATE,
        NOW,
      ),
      "paid-fetch-hard-cap-per-call-exceeded",
    );
  });
});

describe("evaluatePaidFetch — arm window and tier", () => {
  it("denies when arming is required and the wallet is not armed", () => {
    const armed = makePolicyWithService({ armRequired: true });
    expectDeny(
      evaluatePaidFetch(paidFetch(), armed, makeLedger(), IDLE_STATE, NOW),
      "not-armed",
    );
  });

  it("allows when armed (boundary: armedUntil strictly in the future)", () => {
    const armed = makePolicyWithService({ armRequired: true });
    const state = { ...IDLE_STATE, armedUntil: isoAt(60_000) };
    expect(evaluatePaidFetch(paidFetch(), armed, makeLedger(), state, NOW)).toEqual({
      verdict: "auto",
    });
  });

  it("asks the human for a non-auto-approve service", () => {
    const manual = makePolicyWithService({
      services: [
        {
          name: "demo-api",
          origin: SERVICE_ORIGIN,
          facilitator: "demo-facilitator",
          currency: "VRSCTEST",
          maxPricePerCall: "0.01",
          maxPerDay: "0.05",
          autoApprove: false,
        },
      ],
    });
    const decision = evaluatePaidFetch(paidFetch(), manual, makeLedger(), IDLE_STATE, NOW);
    expect(decision).toEqual({ verdict: "confirm", reason: "service-not-auto-approve" });
  });
});
