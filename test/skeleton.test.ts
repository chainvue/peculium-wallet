import { describe, expect, it } from "vitest";

import { PECULIUM_VERSION } from "../src/index.js";

describe("skeleton", () => {
  it("exports a version", () => {
    expect(PECULIUM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
