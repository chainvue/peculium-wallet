import { describe, expect, it } from "vitest";

import {
  HARD_CAPS,
  hardCapsFor,
  nativeCurrencyOf,
  STARTER_HARD_CAPS,
  SUPPORTED_CHAINS,
} from "../src/limits.js";

describe("limits", () => {
  it("whitelists exactly VRSCTEST (mainnet refused by compilation)", () => {
    expect(SUPPORTED_CHAINS).toEqual(["VRSCTEST"]);
  });

  it("HARD_CAPS are 10 / 50 / 250 native coins in satoshis", () => {
    expect(HARD_CAPS.maxPerTxSats).toBe(1_000_000_000n);
    expect(HARD_CAPS.maxPerDaySats).toBe(5_000_000_000n);
    expect(HARD_CAPS.maxTotalSats).toBe(25_000_000_000n);
  });

  it("STARTER_HARD_CAPS are 1 / 5 / 25 native coins in satoshis", () => {
    expect(STARTER_HARD_CAPS.maxPerTxSats).toBe(100_000_000n);
    expect(STARTER_HARD_CAPS.maxPerDaySats).toBe(500_000_000n);
    expect(STARTER_HARD_CAPS.maxTotalSats).toBe(2_500_000_000n);
  });

  it("caps are frozen — runtime mutation cannot widen them", () => {
    expect(Object.isFrozen(HARD_CAPS)).toBe(true);
    expect(Object.isFrozen(STARTER_HARD_CAPS)).toBe(true);
  });

  it("starter mode gets the smaller ceiling", () => {
    expect(hardCapsFor("starter-r-address")).toBe(STARTER_HARD_CAPS);
    expect(hardCapsFor("verusid")).toBe(HARD_CAPS);
  });

  it("the chain-native currency shares the chain name", () => {
    expect(nativeCurrencyOf("VRSCTEST")).toBe("VRSCTEST");
  });
});
