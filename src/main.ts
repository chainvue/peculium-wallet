#!/usr/bin/env node
// Single bin: `peculium mcp` starts the stdio MCP server; every other
// subcommand is the operator CLI (E5). stdout belongs to the MCP protocol —
// human/diagnostic output goes to stderr, always.
//
// Composition (and nothing else) lives here: config dir, node endpoint,
// ledger/audit/policy wiring. The signing backend is the E3b LiteBackend;
// until it lands this build wires the UnavailableBackend, so every spend
// fails definitively with a clear message while reads, precheck and the
// confirm flow work end to end.

import * as os from "node:os";
import * as path from "node:path";

import { NETWORK_CONFIG } from "@chainvue/verus-sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VerusClient } from "verus-rpc";

import { AuditLog } from "./audit.js";
import { PECULIUM_VERSION } from "./index.js";
import { SpendLedger } from "./ledger/ledger.js";
import { LiteBackend } from "./lite-backend.js";
import { nativeCurrencyOf, type SupportedChain } from "./limits.js";
import { buildMcpServer } from "./mcp.js";
import { PolicySource } from "./policy/load.js";
import { PublicNodeReader } from "./reader.js";

/** v1 ships one chain; multi-chain is one server instance per chain (PLAN). */
const CHAIN: SupportedChain = "VRSCTEST";
const DEFAULT_NODE_URL = "https://api.verustest.net";

function fail(message: string): never {
  process.stderr.write(`peculium: ${message}\n`);
  process.exit(1);
}

function configDir(): string {
  return process.env["PECULIUM_DIR"] ?? path.join(os.homedir(), ".peculium", CHAIN);
}

async function runMcp(): Promise<void> {
  const dir = configDir();

  // Fail fast on an unusable config: a server that would deny every call
  // anyway should say why at startup, where the operator sees it.
  const policySource = new PolicySource(dir);
  try {
    policySource.current();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  let ledger: SpendLedger;
  try {
    ledger = SpendLedger.open(dir);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const audit = AuditLog.open(dir);
  for (const requestId of ledger.recoveredRequestIds) {
    audit.write({ event: "ledger-recovery", requestId, action: "marked-ambiguous" });
  }

  const nodeUrl = process.env["PECULIUM_NODE_URL"] ?? DEFAULT_NODE_URL;
  // verus-rpc >= 0.2: omit credentials entirely for public gateways.
  const client = new VerusClient({ url: nodeUrl });
  const nativeCurrencyId =
    CHAIN === "VRSCTEST" ? NETWORK_CONFIG.testnet.chainId : NETWORK_CONFIG.mainnet.chainId;
  const reader = new PublicNodeReader(client, nativeCurrencyOf(CHAIN), nativeCurrencyId);
  const backend = new LiteBackend({ client, dir, chain: CHAIN });

  const server = buildMcpServer({
    policySource,
    ledger,
    backend,
    reader,
    audit,
    stateDir: dir,
    version: PECULIUM_VERSION,
  });

  const passphraseSet = (process.env["PECULIUM_KEYSTORE_PASSPHRASE"] ?? "") !== "";
  process.stderr.write(
    `peculium: MCP server starting (chain ${CHAIN}, config ${dir}, node ${nodeUrl})\n` +
      (passphraseSet
        ? ""
        : `peculium: WARNING — PECULIUM_KEYSTORE_PASSPHRASE is not set; spends will fail ` +
          `cleanly until it is configured in the MCP host env.\n`),
  );
  audit.write({ event: "server-start" });

  const shutdown = (): void => {
    audit.write({ event: "server-stop" });
    audit.close();
    ledger.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}

const command = process.argv[2];
if (command === "mcp") {
  runMcp().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
} else {
  // Everything else is the operator CLI (E5).
  import("./cli/run.js")
    .then(async ({ runCli }) => {
      process.exit(await runCli(process.argv.slice(2)));
    })
    .catch((error: unknown) => {
      fail(error instanceof Error ? error.message : String(error));
    });
}
