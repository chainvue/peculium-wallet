import { describe, expect, it } from "vitest";

import { PeculiumError, PolicyLimitError, PolicyParseError } from "../src/errors.js";
import { parsePolicy } from "../src/policy/schema.js";
import {
  FACILITATOR_ADDRESS,
  NATIVE_AT_HARD_CAPS,
  NATIVE_AT_STARTER_CAPS,
  policyFile,
} from "./helpers.js";

describe("parsePolicy — happy path", () => {
  it("round-trips a valid policy file into bigint satoshis", () => {
    const policy = parsePolicy(policyFile());
    expect(policy.network).toBe("VRSCTEST");
    expect(policy.addressMode).toBe("verusid");
    expect(policy.currencies[0]).toEqual({
      currency: "VRSCTEST",
      maxPerTxSats: 200_000_000n,
      maxPerDaySats: 800_000_000n,
      maxTotalSats: 2_000_000_000n,
    });
    expect(policy.facilitators[0]).toEqual({
      name: "demo-facilitator",
      address: FACILITATOR_ADDRESS,
      currency: "VRSCTEST",
      maxPerTxSats: 50_000_000n,
      maxPerDaySats: 200_000_000n,
      autoApprove: true,
    });
    expect(policy.rate).toEqual({
      maxSendsPerHour: 10,
      minSecondsBetweenSends: 0,
      dedupeWindowSeconds: 600,
    });
  });

  it("accepts native caps at exactly the hard caps (verusid)", () => {
    expect(() => parsePolicy(policyFile({ currencies: NATIVE_AT_HARD_CAPS }))).not.toThrow();
  });

  it("accepts native caps at exactly the starter hard caps (starter mode)", () => {
    expect(() =>
      parsePolicy(
        policyFile({ addressMode: "starter-r-address", currencies: NATIVE_AT_STARTER_CAPS }),
      ),
    ).not.toThrow();
  });

  it("allows one facilitator to carry budgets in several currencies", () => {
    const file = policyFile({
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
    expect(parsePolicy(file).facilitators).toHaveLength(2);
  });
});

describe("parsePolicy — hard-cap enforcement (PolicyLimitError)", () => {
  const overHard = (field: "maxPerTx" | "maxPerDay" | "maxTotal", value: string) => {
    const native = { currency: "VRSCTEST", maxPerTx: "10", maxPerDay: "50", maxTotal: "250" };
    return policyFile({ currencies: [{ ...native, [field]: value }] });
  };

  it("refuses native maxPerTx one satoshi over the hard cap", () => {
    expect(() => parsePolicy(overHard("maxPerTx", "10.00000001"))).toThrow(PolicyLimitError);
  });

  it("refuses native maxPerDay one satoshi over the hard cap", () => {
    expect(() => parsePolicy(overHard("maxPerDay", "50.00000001"))).toThrow(PolicyLimitError);
  });

  it("refuses native maxTotal one satoshi over the hard cap", () => {
    expect(() => parsePolicy(overHard("maxTotal", "250.00000001"))).toThrow(PolicyLimitError);
  });

  it("starter mode is held to the starter caps, not the verusid caps", () => {
    expect(() =>
      parsePolicy(
        policyFile({ addressMode: "starter-r-address", currencies: NATIVE_AT_HARD_CAPS }),
      ),
    ).toThrow(PolicyLimitError);
    expect(() =>
      parsePolicy(
        policyFile({
          addressMode: "starter-r-address",
          currencies: [{ currency: "VRSCTEST", maxPerTx: "1.00000001", maxPerDay: "5", maxTotal: "25" }],
        }),
      ),
    ).toThrow(PolicyLimitError);
  });

  it("non-native currencies have no compiled cap", () => {
    const file = policyFile({
      currencies: [
        { currency: "VRSCTEST", maxPerTx: "2", maxPerDay: "8", maxTotal: "20" },
        { currency: "TOKEN", maxPerTx: "100000", maxPerDay: "500000", maxTotal: "1000000" },
      ],
    });
    expect(() => parsePolicy(file)).not.toThrow();
  });

  it("PolicyLimitError is a PeculiumError with code policy-limit", () => {
    try {
      parsePolicy(overHard("maxPerTx", "11"));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PeculiumError);
      expect((error as PolicyLimitError).code).toBe("policy-limit");
    }
  });
});

describe("parsePolicy — schema rejection (PolicyParseError)", () => {
  it("rejects a policy without the chain-native currency entry", () => {
    const file = policyFile({
      currencies: [{ currency: "TOKEN", maxPerTx: "1", maxPerDay: "5", maxTotal: "10" }],
    });
    expect(() => parsePolicy(file)).toThrow(PolicyParseError);
  });

  it("rejects an empty currencies array", () => {
    expect(() => parsePolicy(policyFile({ currencies: [] }))).toThrow(PolicyParseError);
  });

  it("rejects duplicate currency entries", () => {
    const file = policyFile({
      currencies: [
        { currency: "VRSCTEST", maxPerTx: "1", maxPerDay: "5", maxTotal: "10" },
        { currency: "VRSCTEST", maxPerTx: "2", maxPerDay: "8", maxTotal: "20" },
      ],
    });
    expect(() => parsePolicy(file)).toThrow(PolicyParseError);
  });

  it("rejects amounts with more than 8 decimal places", () => {
    const file = policyFile({
      currencies: [
        { currency: "VRSCTEST", maxPerTx: "0.123456789", maxPerDay: "5", maxTotal: "10" },
      ],
    });
    expect(() => parsePolicy(file)).toThrow(PolicyParseError);
  });

  it("rejects zero and negative caps", () => {
    for (const bad of ["0", "-1"]) {
      const file = policyFile({
        currencies: [{ currency: "VRSCTEST", maxPerTx: bad, maxPerDay: "5", maxTotal: "10" }],
      });
      expect(() => parsePolicy(file)).toThrow(PolicyParseError);
    }
  });

  it("rejects unknown keys at the top level and nested (strict objects)", () => {
    expect(() => parsePolicy({ ...policyFile(), surprise: true })).toThrow(PolicyParseError);
    expect(() =>
      parsePolicy(
        policyFile({
          rate: {
            maxSendsPerHour: 10,
            minSecondsBetweenSends: 0,
            dedupeWindowSeconds: 600,
            bonus: 1,
          } as never,
        }),
      ),
    ).toThrow(PolicyParseError);
  });

  it("rejects an unsupported network and wrong schemaVersion", () => {
    expect(() => parsePolicy({ ...policyFile(), network: "VRSC" })).toThrow(PolicyParseError);
    expect(() => parsePolicy({ ...policyFile(), schemaVersion: 2 })).toThrow(PolicyParseError);
  });

  it("rejects more than 16 facilitators", () => {
    const facilitators = Array.from({ length: 17 }, (_, i) => ({
      name: `facilitator-${i}`,
      address: `RFac${i}`,
      currency: "VRSCTEST",
      maxPerTx: "0.1",
      maxPerDay: "0.5",
      autoApprove: false,
    }));
    expect(() => parsePolicy(policyFile({ facilitators }))).toThrow(PolicyParseError);
  });

  it("rejects more than 64 recipients", () => {
    const recipients = Array.from({ length: 65 }, (_, i) => ({
      name: `recipient-${i}`,
      address: `RRec${i}`,
    }));
    expect(() => parsePolicy(policyFile({ recipients }))).toThrow(PolicyParseError);
  });

  it("rejects rate values outside their bounds", () => {
    const base = { maxSendsPerHour: 10, minSecondsBetweenSends: 0, dedupeWindowSeconds: 600 };
    for (const rate of [
      { ...base, maxSendsPerHour: 0 },
      { ...base, maxSendsPerHour: 61 },
      { ...base, minSecondsBetweenSends: -1 },
      { ...base, minSecondsBetweenSends: 3601 },
      { ...base, dedupeWindowSeconds: -1 },
      { ...base, dedupeWindowSeconds: 3601 },
    ]) {
      expect(() => parsePolicy(policyFile({ rate }))).toThrow(PolicyParseError);
    }
  });

  it("rejects confirmTimeoutSeconds outside 30..600", () => {
    expect(() => parsePolicy(policyFile({ confirmTimeoutSeconds: 29 }))).toThrow(PolicyParseError);
    expect(() => parsePolicy(policyFile({ confirmTimeoutSeconds: 601 }))).toThrow(PolicyParseError);
  });

  it("rejects malformed timestamps", () => {
    expect(() => parsePolicy(policyFile({ createdAt: "yesterday" }))).toThrow(PolicyParseError);
  });

  it("rejects a facilitator in an unconfigured currency (dead config)", () => {
    const file = policyFile({
      facilitators: [
        {
          name: "ghost",
          address: "RGhost1",
          currency: "GHOST",
          maxPerTx: "1",
          maxPerDay: "2",
          autoApprove: true,
        },
      ],
    });
    expect(() => parsePolicy(file)).toThrow(PolicyParseError);
  });

  it("rejects duplicate (name, currency) facilitator entries and conflicting addresses", () => {
    const entry = {
      name: "demo-facilitator",
      address: FACILITATOR_ADDRESS,
      currency: "VRSCTEST",
      maxPerTx: "0.5",
      maxPerDay: "2",
      autoApprove: true,
    };
    expect(() => parsePolicy(policyFile({ facilitators: [entry, { ...entry }] }))).toThrow(
      PolicyParseError,
    );
    expect(() =>
      parsePolicy(
        policyFile({
          facilitators: [entry, { ...entry, currency: "TOKEN", address: "ROther1" }],
        }),
      ),
    ).toThrow(PolicyParseError);
  });

  it("rejects duplicate recipient names", () => {
    const recipients = [
      { name: "alice", address: "RAlice1" },
      { name: "alice", address: "RAlice2" },
    ];
    expect(() => parsePolicy(policyFile({ recipients }))).toThrow(PolicyParseError);
  });

  it("rejects non-object input", () => {
    expect(() => parsePolicy(null)).toThrow(PolicyParseError);
    expect(() => parsePolicy("{}")).toThrow(PolicyParseError);
  });

  it("PolicyParseError carries the offending path in its message", () => {
    try {
      parsePolicy(policyFile({ confirmTimeoutSeconds: 5 }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as PolicyParseError).message).toContain("confirmTimeoutSeconds");
    }
  });
});
