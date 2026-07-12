import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditLog, auditLineSchema } from "../src/audit.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-audit-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

const CLOCK = () => new Date("2026-07-12T12:00:00.000Z");

function readLines(dir: string, file = "audit.jsonl"): unknown[] {
  return fs
    .readFileSync(path.join(dir, file), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

describe("AuditLog", () => {
  it("writes schema-valid lines for every event kind", () => {
    const dir = tempDir();
    const log = AuditLog.open(dir, { clock: CLOCK });
    log.write({
      event: "intent-denied",
      requestId: "req-0001-aa",
      reasonCode: "per-tx-cap-exceeded",
      kind: "topup",
      recipientName: "demo",
      currency: "VRSCTEST",
      amountSats: 123n,
    });
    log.write({ event: "confirm-requested", requestId: "req-0001-aa" });
    log.write({ event: "confirm-declined", requestId: "req-0001-aa" });
    log.write({ event: "policy-changed", oldHash: "aa", newHash: "bb", command: "allow" });
    log.write({ event: "policy-reload", oldHash: "bb", newHash: "cc" });
    log.write({ event: "server-start" });
    log.write({ event: "ledger-recovery", requestId: "req-0001-aa", action: "ambiguous" });
    log.write({ event: "server-stop" });
    log.close();

    const lines = readLines(dir);
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      expect(() => auditLineSchema.parse(line)).not.toThrow();
    }
    const denied = lines[0] as { amountSats: string; at: string };
    expect(denied.amountSats).toBe("123"); // bigint serialized, JSON-safe
    expect(denied.at).toBe("2026-07-12T12:00:00.000Z");
  });

  it("rotates to audit.jsonl.1 past maxBytes; only ONE prior generation is kept", () => {
    const dir = tempDir();
    const log = AuditLog.open(dir, { clock: CLOCK, maxBytes: 200 });
    for (let i = 0; i < 10; i += 1) {
      log.write({ event: "server-start" });
    }
    log.close();
    // ~62-byte lines, 200-byte cap: rotations at writes 4, 7 and 10. Each
    // rotation REPLACES audit.jsonl.1 (bounded by design — the audit trail
    // is best-effort narrative, the ledger is the money record), so only
    // the last full generation plus the fresh file survive.
    const current = readLines(dir);
    const rotated = readLines(dir, "audit.jsonl.1");
    expect(rotated).toHaveLength(3);
    expect(current).toHaveLength(1);
    // Nothing else accumulates: exactly the two files exist.
    expect(fs.readdirSync(dir).sort()).toEqual(["audit.jsonl", "audit.jsonl.1"]);
  });

  it("a write failure never throws (fire-and-forget) and disables quietly", () => {
    const dir = tempDir();
    const log = AuditLog.open(dir, { clock: CLOCK });
    log.close(); // fd gone: writes must become silent no-ops
    expect(() => log.write({ event: "server-stop" })).not.toThrow();
    expect(readLines(dir)).toHaveLength(0);
  });

  it("open on an unwritable target never throws, writes become no-ops", () => {
    const dir = tempDir();
    // Claim audit.jsonl as a DIRECTORY so openSync fails.
    fs.mkdirSync(path.join(dir, "audit.jsonl"));
    const log = AuditLog.open(dir, { clock: CLOCK });
    expect(() => log.write({ event: "server-start" })).not.toThrow();
  });

  it("rejects a malformed event at the schema gate without writing", () => {
    const dir = tempDir();
    const log = AuditLog.open(dir, { clock: CLOCK });
    // Force an invalid shape past the compiler — write() must swallow it.
    log.write({ event: "policy-changed", oldHash: "", newHash: "x", command: "y" } as never);
    log.close();
    expect(readLines(dir)).toHaveLength(0);
  });
});
