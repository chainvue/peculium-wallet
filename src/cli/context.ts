/**
 * CLI plumbing — the operator surface's shared context and helpers.
 *
 * Every command is a pure-ish function of (args, CliContext) so tests drive
 * them directly with an in-memory context: no child processes, no real
 * prompts, injectable clock/client. Only run.ts touches the real terminal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";

import { parseAmount, VerusClient } from "@chainvue/verus-rpc";

import { PeculiumError } from "../errors.js";
import { parseLedgerLine, type LedgerRecord } from "../ledger/records.js";
import type { SupportedChain } from "../limits.js";
import { loadPolicy, type LoadedPolicy } from "../policy/load.js";
import { parsePolicy, type PolicyFileInput } from "../policy/schema.js";

/** Bad invocation — run.ts prints the message + usage and exits 2. */
export class CliUsageError extends PeculiumError {
  constructor(message: string) {
    super("cli-usage", message);
    this.name = "CliUsageError";
  }
}

/** Everything a command may touch. Tests build this in memory. */
export interface CliContext {
  dir: string;
  chain: SupportedChain;
  nodeUrl: string;
  env: NodeJS.ProcessEnv;
  clock: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Ask a question, echoing input (names, confirmations). */
  promptVisible: (question: string) => Promise<string>;
  /** Ask a question WITHOUT echoing input (passphrases, keys). */
  promptHidden: (question: string) => Promise<string>;
  /** RPC client factory (tests inject a MockTransport-backed one). */
  makeClient: () => VerusClient;
}

export function buildDefaultContext(dir: string, chain: SupportedChain, nodeUrl: string): CliContext {
  return {
    dir,
    chain,
    nodeUrl,
    env: process.env,
    clock: () => new Date(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    promptVisible: async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(`${question} `)).trim();
      } finally {
        rl.close();
      }
    },
    promptHidden: async (question) => {
      // Mute the echo: readline writes go to a sink; the question itself is
      // printed directly first.
      process.stdout.write(`${question} `);
      const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
      const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
      try {
        const answer = await rl.question("");
        process.stdout.write("\n");
        return answer.trim();
      } finally {
        rl.close();
      }
    },
    makeClient: () => new VerusClient({ url: nodeUrl }),
  };
}

// ------------------------------------------------------------ arg helpers

/** Split argv into positionals and --flag[=value] options (single-value). */
export function parseArgs(argv: readonly string[]): {
  positionals: string[];
  flags: Map<string, string | true>;
} {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positionals, flags };
}

/** A flag that must carry a value. */
export function requireValue(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value === true) {
    throw new CliUsageError(`--${name} requires a value`);
  }
  return value;
}

/** Parse "90s" / "30m" / "2h" / "1d" into milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+)([smhd])$/.exec(text);
  if (match === null) {
    throw new CliUsageError(`invalid duration "${text}" (use e.g. 90s, 30m, 2h, 1d)`);
  }
  const value = Number(match[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s"];
  return value * unit;
}

/** Parse a decimal coin amount into satoshis (verus-rpc grammar), > 0. */
export function parsePositiveAmount(text: string, what: string): bigint {
  let sats: bigint;
  try {
    sats = parseAmount(text);
  } catch (error) {
    throw new CliUsageError(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sats <= 0n) {
    throw new CliUsageError(`${what} must be positive`);
  }
  return sats;
}

// ------------------------------------------------------- policy edit helper

const POLICY_FILE = "policy.json";

/** Read the raw JSON-safe policy.json (the CLI edits THIS shape). */
export function readPolicyInput(dir: string): PolicyFileInput {
  const raw = fs.readFileSync(path.join(dir, POLICY_FILE), "utf8");
  return JSON.parse(raw) as PolicyFileInput;
}

/**
 * Validate and atomically write a policy input. Validation runs the REAL
 * parsePolicy (schema + compiled hard caps) — an edit that would produce an
 * invalid or over-cap policy never reaches disk. Returns the loaded result.
 */
export function writePolicyInput(
  dir: string,
  input: PolicyFileInput,
  clock: () => Date,
): LoadedPolicy {
  input.updatedAt = clock().toISOString();
  parsePolicy(input); // throws PolicyParseError / PolicyLimitError
  const finalPath = path.join(dir, POLICY_FILE);
  const tempPath = path.join(dir, `${POLICY_FILE}.tmp-${process.pid}`);
  const payload = `${JSON.stringify(input, null, 2)}\n`;
  const fd = fs.openSync(tempPath, "w", 0o600);
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, finalPath);
  return loadPolicy(dir);
}

// ------------------------------------------------ lock-free ledger snapshot

/** A read-only, point-in-time fold of ledger.jsonl (no lock taken). */
export interface LedgerSnapshotRow {
  requestId: string;
  kind: "topup" | "send" | "paid-fetch";
  recipientName: string;
  /** Resolved destination: recipient/facilitator address, or service origin. */
  recipientAddress: string;
  currency: string;
  amountSats: bigint;
  pendingAt: string;
  state: "pending" | "broadcast" | "confirmed" | "failed" | "settled" | "ambiguous" | "resolved";
  txid: string | null;
  countsAsSpent: boolean;
}

export interface LedgerSnapshot {
  rows: LedgerSnapshotRow[];
  /** ledger.jsonl ends in a torn line (crash during append). */
  tornTail: boolean;
  /** A line failed to parse (corruption beyond the tail). */
  corrupt: string | null;
}

/**
 * Fold ledger.jsonl WITHOUT taking the pid lock — safe because it only
 * reads: `status`/`history`/`doctor` must work while the MCP server holds
 * the lock. The view is point-in-time and advisory; the OWNING process's
 * `SpendLedger` remains the authority for money decisions.
 */
export function readLedgerSnapshot(dir: string): LedgerSnapshot {
  let content: string;
  try {
    content = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { rows: [], tornTail: false, corrupt: null };
    }
    throw error;
  }
  if (content === "") {
    return { rows: [], tornTail: false, corrupt: null };
  }
  const lines = content.split("\n");
  const tail = lines.pop();
  const tornTail = tail !== "";
  const byId = new Map<string, LedgerSnapshotRow>();
  for (const [index, line] of lines.entries()) {
    let record: LedgerRecord;
    try {
      record = parseLedgerLine(line);
    } catch (error) {
      return {
        rows: [...byId.values()],
        tornTail,
        corrupt: `line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (record.type === "pending") {
      byId.set(record.requestId, {
        requestId: record.requestId,
        kind: record.kind,
        recipientName: record.recipientName,
        recipientAddress: record.recipientAddress,
        currency: record.currency,
        amountSats: BigInt(record.amountSats),
        pendingAt: record.at,
        state: "pending",
        txid: null,
        countsAsSpent: true,
      });
      continue;
    }
    const row = byId.get(record.requestId);
    if (row === undefined) {
      continue; // tolerated in the advisory view; open() would refuse
    }
    switch (record.type) {
      case "broadcast":
        row.state = "broadcast";
        row.txid = record.txid;
        break;
      case "confirmed":
        row.state = "confirmed";
        break;
      case "failed":
        row.state = "failed";
        row.countsAsSpent = false;
        break;
      case "settled":
        row.state = "settled";
        break;
      case "ambiguous":
        row.state = "ambiguous";
        break;
      case "resolved":
        row.state = "resolved";
        row.txid = record.txid ?? row.txid;
        row.countsAsSpent = record.outcome === "spent";
        break;
    }
  }
  return { rows: [...byId.values()], tornTail, corrupt: null };
}
