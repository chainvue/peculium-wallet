import { describe, expect, it } from "vitest";

import {
  PeculiumError,
  PolicyLimitError,
  PolicyParseError,
  StateParseError,
} from "../src/errors.js";

describe("errors", () => {
  it("every subclass is a PeculiumError with a stable code and name", () => {
    const cases: Array<[PeculiumError, string, string]> = [
      [new PolicyLimitError("over"), "policy-limit", "PolicyLimitError"],
      [new PolicyParseError("bad"), "policy-parse", "PolicyParseError"],
      [new StateParseError("bad"), "state-parse", "StateParseError"],
    ];
    for (const [error, code, name] of cases) {
      expect(error).toBeInstanceOf(PeculiumError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.name).toBe(name);
    }
  });

  it("preserves the message", () => {
    expect(new PolicyLimitError("cap exceeded").message).toBe("cap exceeded");
  });
});
