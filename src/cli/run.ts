/**
 * CLI dispatch — `peculium <command> …` for every non-`mcp` command.
 *
 * Global flags (before or after the command):
 *   --dir <path>   config dir (default ~/.peculium/VRSCTEST or PECULIUM_DIR)
 *   --node <url>   node endpoint (default PECULIUM_NODE_URL or public testnet)
 */

import * as os from "node:os";
import * as path from "node:path";

import { PeculiumError } from "../errors.js";
import type { SupportedChain } from "../limits.js";
import { buildDefaultContext, CliUsageError, type CliContext } from "./context.js";
import { cmdInit } from "./init.js";
import { cmdIdentity } from "./identity.js";
import { cmdDoctor, cmdHistory, cmdReport, cmdStatus } from "./inspect.js";
import { cmdBackup, cmdExportKey, cmdRestore } from "./keyops.js";
import {
  cmdAllow,
  cmdArm,
  cmdDisarm,
  cmdGrant,
  cmdResolve,
  cmdRevoke,
  cmdSet,
} from "./mutate.js";

const CHAIN: SupportedChain = "VRSCTEST";
const DEFAULT_NODE_URL = "https://api.verustest.net";

export const USAGE = `peculium — the safe Verus wallet for AI agents

usage: peculium <command> [options]

  mcp                                     start the MCP server on stdio

  init (--starter | --adopt) [--dry-run]  provision keystore + policy + state
  status                                  policy, caps, usage, ledger overview
  history [--limit N]                     recent money requests + audit events
  report [--since H] [--recipient N] [--group-by day|recipient|kind]
                                          spend aggregates + recent requests
  doctor                                  health checks (exit code = failures)

  grant <amount> [--currency C] [--ttl 2h]   one-shot session budget
  grant --revoke                              clear the grant
  arm [minutes] / disarm                      time-boxed enablement window
  allow recipient <name> <address>            allowlist a send recipient
  allow facilitator <name> <address> --max-per-tx X --max-per-day Y
        [--currency C] [--auto-approve] [--api-url <url>]
                                              allowlist a topup facilitator
  allow service <name> --origin <url> --facilitator <name>
        --max-per-call X --max-per-day Y [--currency C] [--auto-approve]
                                              allowlist a v402 paid service
  revoke <recipient|facilitator|service> <name>   remove allowlist entries
  set cap <currency> --per-tx X --per-day Y --total Z
  set rate [--max-per-hour N] [--min-interval S] [--dedupe-window S]
  set confirm-timeout <seconds>
  set arm-required <true|false>
  resolve <requestId> (--spent <txid> | --not-spent)
  resolve --repair-tail [--yes]

  identity create <name> --revocation <id> --recovery <id> [--referral <id>]
                                          register a VerusID (burns the protocol fee)
  export-key                              print the decrypted WIF (ritual)
  backup <file.pcbk> / restore <file.pcbk>   encrypted wallet archive

global options: --dir <path>  --node <url>`;

type Command = (argv: readonly string[], ctx: CliContext) => number | Promise<number>;

const COMMANDS: Record<string, Command> = {
  init: cmdInit,
  status: cmdStatus,
  history: cmdHistory,
  report: cmdReport,
  doctor: cmdDoctor,
  grant: cmdGrant,
  arm: cmdArm,
  disarm: cmdDisarm,
  allow: cmdAllow,
  revoke: cmdRevoke,
  set: cmdSet,
  resolve: cmdResolve,
  identity: cmdIdentity,
  "export-key": cmdExportKey,
  backup: cmdBackup,
  restore: cmdRestore,
};

/** Extract --dir/--node wherever they appear; return the remaining argv. */
function extractGlobals(argv: readonly string[]): {
  rest: string[];
  dir: string;
  nodeUrl: string;
} {
  const rest: string[] = [];
  let dir = process.env["PECULIUM_DIR"] ?? path.join(os.homedir(), ".peculium", CHAIN);
  let nodeUrl = process.env["PECULIUM_NODE_URL"] ?? DEFAULT_NODE_URL;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--dir" && argv[i + 1] !== undefined) {
      dir = argv[i + 1] as string;
      i += 1;
    } else if (arg === "--node" && argv[i + 1] !== undefined) {
      nodeUrl = argv[i + 1] as string;
      i += 1;
    } else {
      rest.push(arg);
    }
  }
  return { rest, dir, nodeUrl };
}

/** Run one CLI invocation; returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  makeContext: (dir: string, chain: SupportedChain, nodeUrl: string) => CliContext = buildDefaultContext,
): Promise<number> {
  const { rest, dir, nodeUrl } = extractGlobals(argv);
  const commandName = rest[0];
  if (commandName === undefined || commandName === "help" || commandName === "--help") {
    console.error(USAGE);
    return commandName === undefined ? 2 : 0;
  }
  const command = COMMANDS[commandName];
  if (command === undefined) {
    console.error(`peculium: unknown command "${commandName}"\n`);
    console.error(USAGE);
    return 2;
  }
  const ctx = makeContext(dir, CHAIN, nodeUrl);
  try {
    return await command(rest.slice(1), ctx);
  } catch (error) {
    if (error instanceof CliUsageError) {
      ctx.err(`peculium ${commandName}: ${error.message}`);
      return 2;
    }
    if (error instanceof PeculiumError) {
      ctx.err(`peculium ${commandName}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
