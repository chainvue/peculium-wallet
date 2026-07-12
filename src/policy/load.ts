/**
 * Policy file IO + freshness — the plumbing around the pure `parsePolicy`.
 *
 * The gate reloads the policy before EVERY spend (PLAN.md: reload-on-change
 * before every gated call, reload failure ⇒ deny). `PolicySource` makes
 * that cheap: `refresh()` re-stats `policy.json` and only re-reads and
 * re-validates when mtime or size moved. ANY reload failure throws — the
 * caller denies, it never falls back to a stale policy for a NEW decision
 * (fail closed).
 *
 * The `policyHash` (sha256 over the raw file bytes) travels into every
 * ledger `pending` row and the audit trail, so each spend records exactly
 * which policy text approved it.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { PeculiumError, PolicyParseError } from "../errors.js";
import { parsePolicy, type Policy } from "./schema.js";

const POLICY_FILE = "policy.json";

/**
 * `policy.json` does not exist. A wallet without a policy cannot spend —
 * the fix is `peculium init`, not a default policy (there is no safe one).
 */
export class PolicyMissingError extends PeculiumError {
  constructor(dir: string) {
    super(
      "policy-missing",
      `no policy at ${path.join(dir, POLICY_FILE)} — run \`peculium init\` first.`,
    );
    this.name = "PolicyMissingError";
  }
}

/** A validated policy together with the file identity it was read from. */
export interface LoadedPolicy {
  policy: Policy;
  /** sha256 hex over the raw file bytes — the policy's identity everywhere. */
  policyHash: string;
  /** File mtime at read time (freshness check input, not a trust anchor). */
  mtimeMs: number;
  /** File size at read time (second freshness signal beside mtime). */
  sizeBytes: number;
}

/**
 * The result of {@link PolicySource.refresh}. `changed` compares policy
 * HASHES, not stat data: a touched file with identical bytes is reloaded
 * but reported unchanged, so the audit trail never logs a no-op "reload".
 */
export type PolicyRefreshResult =
  | { policy: LoadedPolicy; changed: false }
  | { policy: LoadedPolicy; changed: true; previousHash: string };

/**
 * Read, hash and validate `policy.json` from the config dir. Throws
 * `PolicyMissingError` when the file does not exist, `PolicyParseError`
 * for invalid JSON or schema violations, and `PolicyLimitError` when the
 * chain-native caps exceed the compiled hard caps (both from parsePolicy).
 * stat and content come from one open fd, so hash, mtime and size always
 * describe the same bytes.
 */
export function loadPolicy(dir: string): LoadedPolicy {
  const filePath = path.join(dir, POLICY_FILE);
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PolicyMissingError(dir);
    }
    throw error;
  }
  let raw: Buffer;
  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(fd);
    raw = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const policyHash = createHash("sha256").update(raw).digest("hex");
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PolicyParseError(`policy.json is not valid JSON: ${detail}`);
  }
  return {
    policy: parsePolicy(json),
    policyHash,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

/**
 * A cached view of one directory's `policy.json` with cheap freshness
 * checks. Loading is lazy: the first `current()` or `refresh()` reads the
 * file. A FAILED reload leaves the previous cache in place — safe because
 * the gate refreshes before every decision and denies on the throw; the
 * stale value is never used to approve new money.
 */
export class PolicySource {
  private readonly dir: string;
  private cached: LoadedPolicy | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** The cached policy, loading it on first use. Never re-stats the file. */
  current(): LoadedPolicy {
    if (this.cached === null) {
      this.cached = loadPolicy(this.dir);
    }
    return this.cached;
  }

  /**
   * Re-stat `policy.json`: unchanged mtime+size ⇒ the cached value;
   * anything else ⇒ full reload + revalidation. The very first load is the
   * baseline and reports `changed: false` (there is nothing it changed
   * from). Throws on any stat/read/parse/limit failure — callers deny.
   */
  refresh(): PolicyRefreshResult {
    if (this.cached === null) {
      this.cached = loadPolicy(this.dir);
      return { policy: this.cached, changed: false };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(this.dir, POLICY_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PolicyMissingError(this.dir);
      }
      throw error;
    }
    if (stat.mtimeMs === this.cached.mtimeMs && stat.size === this.cached.sizeBytes) {
      return { policy: this.cached, changed: false };
    }
    const previousHash = this.cached.policyHash;
    const next = loadPolicy(this.dir);
    this.cached = next;
    return next.policyHash === previousHash
      ? { policy: next, changed: false }
      : { policy: next, changed: true, previousHash };
  }
}
