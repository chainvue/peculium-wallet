import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateParseError } from "../src/errors.js";
import { INITIAL_STATE, type WalletState } from "../src/state.js";
import { depleteGrant, readState, writeState } from "../src/state-io.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-state-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

const ARMED_WITH_GRANT: WalletState = {
  schemaVersion: 1,
  armedUntil: "2026-07-12T18:00:00.000Z",
  grant: {
    currency: "VRSCTEST",
    remainingSats: 500_000_000n,
    expiresAt: "2026-07-12T20:00:00.000Z",
  },
};

describe("state IO", () => {
  it("a missing file reads as the initial state (the one benign default)", () => {
    expect(readState(tempDir())).toEqual(INITIAL_STATE);
  });

  it("round-trips arm + grant through write and read", () => {
    const dir = tempDir();
    writeState(dir, ARMED_WITH_GRANT);
    expect(readState(dir)).toEqual(ARMED_WITH_GRANT);
  });

  it("write is atomic: no temp file remains and mode is 0600", () => {
    const dir = tempDir();
    writeState(dir, ARMED_WITH_GRANT);
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(["state.json"]);
    const mode = fs.statSync(path.join(dir, "state.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("invalid JSON throws StateParseError, never a silent default", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "state.json"), "{ torn", { mode: 0o600 });
    expect(() => readState(dir)).toThrow(StateParseError);
  });

  it("schema-invalid content throws StateParseError", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ schemaVersion: 1, armedUntil: 42, grant: null }),
      { mode: 0o600 },
    );
    expect(() => readState(dir)).toThrow(StateParseError);
  });

  it("a read error other than ENOENT propagates (fail closed)", () => {
    const dir = tempDir();
    // state.json as a DIRECTORY makes readFileSync throw EISDIR.
    fs.mkdirSync(path.join(dir, "state.json"));
    expect(() => readState(dir)).toThrow();
  });
});

describe("depleteGrant", () => {
  it("reduces the remaining grant by the spend", () => {
    const next = depleteGrant(ARMED_WITH_GRANT, "VRSCTEST", 100_000_000n);
    expect(next.grant?.remainingSats).toBe(400_000_000n);
    // pure: the input state is untouched
    expect(ARMED_WITH_GRANT.grant?.remainingSats).toBe(500_000_000n);
  });

  it("floors at zero when the spend exceeds the remainder", () => {
    const next = depleteGrant(ARMED_WITH_GRANT, "VRSCTEST", 9_999_999_999n);
    expect(next.grant?.remainingSats).toBe(0n);
  });

  it("is a no-op without a grant, for another currency, or non-positive amounts", () => {
    expect(depleteGrant(INITIAL_STATE, "VRSCTEST", 1n)).toBe(INITIAL_STATE);
    expect(depleteGrant(ARMED_WITH_GRANT, "TOKEN", 1n)).toBe(ARMED_WITH_GRANT);
    expect(depleteGrant(ARMED_WITH_GRANT, "VRSCTEST", 0n)).toBe(ARMED_WITH_GRANT);
    expect(depleteGrant(ARMED_WITH_GRANT, "VRSCTEST", -5n)).toBe(ARMED_WITH_GRANT);
  });
});
