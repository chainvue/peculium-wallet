/**
 * `peculium init` — provision a wallet directory: keystore + policy + state.
 *
 * Modes:
 *   --starter      generate a fresh keypair (plain R-address, NO recovery —
 *                  the compiled starter hard caps apply)
 *   --adopt        adopt an existing key: the WIF is PROMPTED (hidden),
 *                  never taken from argv (shell history is forever)
 *   (creating a VerusID end-to-end is the E6 flow; init prints a pointer)
 *
 * The keystore passphrase comes from PECULIUM_KEYSTORE_PASSPHRASE or a
 * hidden prompt (asked twice). `--dry-run` prints what would be written and
 * touches nothing.
 */

import { VerusSDK } from "@chainvue/verus-typescript-sdk";

import { createKeystoreFile, writeKeystoreFile } from "../keystore.js";
import type { AddressMode } from "../limits.js";
import type { PolicyFileInput } from "../policy/schema.js";
import { INITIAL_STATE } from "../state.js";
import { writeState } from "../state-io.js";
import { CliUsageError, parseArgs, writePolicyInput, type CliContext } from "./context.js";

/** Conservative starter policy — well inside the compiled hard caps. */
function defaultPolicy(
  agentAddress: string,
  addressMode: AddressMode,
  chain: string,
  now: string,
): PolicyFileInput {
  const caps =
    addressMode === "starter-r-address"
      ? { maxPerTx: "0.25", maxPerDay: "1", maxTotal: "5" }
      : { maxPerTx: "1", maxPerDay: "4", maxTotal: "20" };
  return {
    schemaVersion: 1,
    network: chain as PolicyFileInput["network"],
    agentAddress,
    addressMode,
    currencies: [{ currency: chain, ...caps }],
    facilitators: [],
    recipients: [],
    rate: { maxSendsPerHour: 6, minSecondsBetweenSends: 15, dedupeWindowSeconds: 600 },
    armRequired: false,
    confirmTimeoutSeconds: 120,
    createdAt: now,
    updatedAt: now,
  };
}

async function obtainPassphrase(ctx: CliContext): Promise<string> {
  const fromEnv = ctx.env["PECULIUM_KEYSTORE_PASSPHRASE"];
  if (fromEnv !== undefined && fromEnv !== "") {
    ctx.err("Using the keystore passphrase from PECULIUM_KEYSTORE_PASSPHRASE.");
    return fromEnv;
  }
  const first = await ctx.promptHidden("Choose a keystore passphrase (min 8 chars):");
  const second = await ctx.promptHidden("Repeat it:");
  if (first !== second) {
    throw new CliUsageError("passphrases do not match");
  }
  return first;
}

export async function cmdInit(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv);
  const starter = flags.has("starter");
  const adopt = flags.has("adopt");
  const dryRun = flags.has("dry-run");
  if (starter === adopt) {
    throw new CliUsageError(
      "pick exactly one mode: --starter (fresh R-address) or --adopt (existing key). " +
        "Creating a fresh VerusID end to end is the identity flow — see the E6 runbook.",
    );
  }

  let wif: string;
  let address: string;
  let addressMode: AddressMode;
  if (starter) {
    wif = VerusSDK.generateWif();
    address = await VerusSDK.deriveAddress(wif);
    addressMode = "starter-r-address";
  } else {
    wif = await ctx.promptHidden("Paste the WIF to adopt (input hidden):");
    if (wif === "") {
      throw new CliUsageError("no WIF provided");
    }
    try {
      address = await VerusSDK.deriveAddress(wif);
    } catch (error) {
      throw new CliUsageError(
        `the WIF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const mode = await ctx.promptVisible(
      `Derived address ${address}. Is this address a VerusID primary address? [y/N]`,
    );
    addressMode = mode.toLowerCase().startsWith("y") ? "verusid" : "starter-r-address";
  }

  const now = ctx.clock().toISOString();
  const policy = defaultPolicy(address, addressMode, ctx.chain, now);

  if (dryRun) {
    ctx.out(`[dry-run] would create in ${ctx.dir}:`);
    ctx.out(`  keystore.json  (${addressMode}, address ${address})`);
    ctx.out(`  policy.json:`);
    ctx.out(JSON.stringify(policy, null, 2));
    ctx.out(`  state.json     (disarmed, no grant)`);
    return 0;
  }

  const passphrase = await obtainPassphrase(ctx);
  const keystore = createKeystoreFile({
    wif,
    passphrase,
    address,
    addressMode,
    clock: ctx.clock,
  });
  writeKeystoreFile(ctx.dir, keystore); // refuses to overwrite an existing key
  writePolicyInput(ctx.dir, policy, ctx.clock);
  writeState(ctx.dir, INITIAL_STATE);

  ctx.out(`Wallet initialized in ${ctx.dir}`);
  ctx.out(``);
  ctx.out(`  address:      ${address}`);
  ctx.out(`  address mode: ${addressMode}`);
  if (addressMode === "starter-r-address") {
    ctx.out(`  NOTE: a plain R-address has NO revocation/recovery — key loss is final.`);
    ctx.out(`        The compiled starter hard caps apply. Upgrade path: a VerusID`);
    ctx.out(`        with cold revoke/recover authorities (peculium docs, E6 runbook).`);
  }
  ctx.out(``);
  ctx.out(`Fund it on VRSCTEST via the faucet: https://faucet.verus.services (or ask`);
  ctx.out(`in the Verus Discord #testnet channel), then check with \`peculium doctor\`.`);
  ctx.out(``);
  ctx.out(`MCP host config block (Claude Code: ~/.claude.json | Desktop: claude_desktop_config.json):`);
  ctx.out(
    JSON.stringify(
      {
        mcpServers: {
          peculium: {
            command: "npx",
            args: ["-y", "@chainvue/peculium", "mcp"],
            env: { PECULIUM_KEYSTORE_PASSPHRASE: "<your keystore passphrase>" },
          },
        },
      },
      null,
      2,
    ),
  );
  return 0;
}
