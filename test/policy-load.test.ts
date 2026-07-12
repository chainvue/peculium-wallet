import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PolicyLimitError, PolicyParseError } from "../src/errors.js";
import { loadPolicy, PolicyMissingError, PolicySource } from "../src/policy/load.js";
import type { PolicyFileInput } from "../src/policy/schema.js";
import { policyFile } from "./helpers.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-policy-load-"));
  dirs.push(dir);
  return dir;
}

function policyPath(dir: string): string {
  return path.join(dir, "policy.json");
}

function writePolicy(dir: string, file: PolicyFileInput): void {
  fs.writeFileSync(policyPath(dir), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

/** Force a visibly different mtime so stat-based freshness must trigger. */
function bumpMtime(dir: string, offsetMs: number): void {
  const at = new Date(Date.now() + offsetMs);
  fs.utimesSync(policyPath(dir), at, at);
}

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("loadPolicy", () => {
  it("returns the parsed policy with hash, mtime and size of the raw bytes", () => {
    const dir = tempDir();
    writePolicy(dir, policyFile());
    const loaded = loadPolicy(dir);
    const raw = fs.readFileSync(policyPath(dir));
    const stat = fs.statSync(policyPath(dir));
    expect(loaded.policy.network).toBe("VRSCTEST");
    expect(loaded.policyHash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(loaded.sizeBytes).toBe(stat.size);
    expect(loaded.mtimeMs).toBe(stat.mtimeMs);
  });

  it("a missing file throws PolicyMissingError pointing at peculium init", () => {
    const dir = tempDir();
    expect(() => loadPolicy(dir)).toThrow(PolicyMissingError);
    expect(() => loadPolicy(dir)).toThrow(/peculium init/);
  });

  it("invalid JSON throws PolicyParseError", () => {
    const dir = tempDir();
    fs.writeFileSync(policyPath(dir), "{ not json", { mode: 0o600 });
    expect(() => loadPolicy(dir)).toThrow(PolicyParseError);
  });

  it("schema violations propagate as PolicyParseError", () => {
    const dir = tempDir();
    fs.writeFileSync(policyPath(dir), JSON.stringify({ schemaVersion: 2 }), { mode: 0o600 });
    expect(() => loadPolicy(dir)).toThrow(PolicyParseError);
  });

  it("native caps above the compiled hard caps propagate as PolicyLimitError", () => {
    const dir = tempDir();
    writePolicy(
      dir,
      policyFile({
        currencies: [{ currency: "VRSCTEST", maxPerTx: "11", maxPerDay: "50", maxTotal: "250" }],
        facilitators: [],
      }),
    );
    expect(() => loadPolicy(dir)).toThrow(PolicyLimitError);
  });
});

describe("PolicySource", () => {
  it("current() loads lazily once and never re-stats", () => {
    const dir = tempDir();
    writePolicy(dir, policyFile());
    const source = new PolicySource(dir);
    const first = source.current();
    // A changed file is invisible to current() until refresh().
    writePolicy(dir, policyFile({ recipients: [] }));
    bumpMtime(dir, 5_000);
    expect(source.current()).toBe(first);
  });

  it("the first refresh is the baseline load and reports changed: false", () => {
    const dir = tempDir();
    writePolicy(dir, policyFile());
    const refreshed = new PolicySource(dir).refresh();
    expect(refreshed.changed).toBe(false);
    expect(refreshed.policy.policy.agentAddress).toBe("RAgent1111111111111111111111111111");
  });

  it("unchanged mtime+size serves the cached object without a reload", () => {
    const dir = tempDir();
    writePolicy(dir, policyFile());
    const source = new PolicySource(dir);
    const first = source.current();
    const refreshed = source.refresh();
    expect(refreshed.changed).toBe(false);
    expect(refreshed.policy).toBe(first);
  });

  it("a changed file is fully reloaded and reported with the previous hash", () => {
    const dir = tempDir();
    writePolicy(dir, policyFile());
    const source = new PolicySource(dir);
    const before = source.current();
    writePolicy(dir, policyFile({ recipients: [] }));
    bumpMtime(dir, 5_000);
    const refreshed = source.refresh();
    expect(refreshed.changed).toBe(true);
    if (refreshed.changed) {
      expect(refreshed.previousHash).toBe(before.policyHash);
    }
    expect(refreshed.policy.policy.recipients).toEqual([]);
    expect(refreshed.policy.policyHash).not.toBe(before.policyHash);
    expect(source.current()).toBe(refreshed.policy);
  });

  it("a touched file with identical bytes reloads but reports changed: false", () => {
    const dir = tempDir();
    writePolicy(dir, policyFile());
    const source = new PolicySource(dir);
    const before = source.current();
    bumpMtime(dir, 5_000);
    const refreshed = source.refresh();
    expect(refreshed.changed).toBe(false);
    expect(refreshed.policy.policyHash).toBe(before.policyHash);
  });

  it("refresh throws on a corrupted file — every call, fail closed", () => {
    const dir = tempDir();
    writePolicy(dir, policyFile());
    const source = new PolicySource(dir);
    source.current();
    fs.writeFileSync(policyPath(dir), "{ torn", { mode: 0o600 });
    bumpMtime(dir, 5_000);
    expect(() => source.refresh()).toThrow(PolicyParseError);
    expect(() => source.refresh()).toThrow(PolicyParseError);
  });

  it("refresh throws PolicyMissingError when the file disappeared", () => {
    const dir = tempDir();
    writePolicy(dir, policyFile());
    const source = new PolicySource(dir);
    source.current();
    fs.rmSync(policyPath(dir));
    expect(() => source.refresh()).toThrow(PolicyMissingError);
  });
});
