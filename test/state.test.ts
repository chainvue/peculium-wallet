import { describe, expect, it } from "vitest";

import { StateParseError } from "../src/errors.js";
import { INITIAL_STATE, parseState, serializeState, type WalletState } from "../src/state.js";

describe("state", () => {
  const armed: WalletState = {
    schemaVersion: 1,
    armedUntil: "2026-07-12T13:00:00.000Z",
    grant: {
      currency: "VRSCTEST",
      remainingSats: 123_456_789n,
      expiresAt: "2026-07-12T14:00:00.000Z",
    },
  };

  it("round-trips through serialize/parse", () => {
    expect(parseState(serializeState(armed))).toEqual(armed);
    expect(parseState(serializeState(INITIAL_STATE))).toEqual(INITIAL_STATE);
  });

  it("serializes remainingSats as an integer satoshi string", () => {
    const file = serializeState(armed);
    expect(file.grant?.remainingSats).toBe("123456789");
  });

  it("parses a zero remaining grant", () => {
    const state = parseState({
      schemaVersion: 1,
      armedUntil: null,
      grant: { currency: "TOKEN", remainingSats: "0", expiresAt: "2026-07-12T14:00:00Z" },
    });
    expect(state.grant?.remainingSats).toBe(0n);
  });

  it("rejects non-integer, negative and non-canonical satoshi strings", () => {
    for (const bad of ["1.5", "-5", "abc", "007", ""]) {
      expect(() =>
        parseState({
          schemaVersion: 1,
          armedUntil: null,
          grant: { currency: "TOKEN", remainingSats: bad, expiresAt: "2026-07-12T14:00:00Z" },
        }),
      ).toThrow(StateParseError);
    }
  });

  it("rejects malformed timestamps and unknown keys (strict)", () => {
    expect(() =>
      parseState({ schemaVersion: 1, armedUntil: "soon", grant: null }),
    ).toThrow(StateParseError);
    expect(() =>
      parseState({ schemaVersion: 1, armedUntil: null, grant: null, extra: 1 }),
    ).toThrow(StateParseError);
    expect(() => parseState({ schemaVersion: 2, armedUntil: null, grant: null })).toThrow(
      StateParseError,
    );
  });

  it("INITIAL_STATE is disarmed, grantless and frozen", () => {
    expect(INITIAL_STATE).toEqual({ schemaVersion: 1, armedUntil: null, grant: null });
    expect(Object.isFrozen(INITIAL_STATE)).toBe(true);
  });
});
