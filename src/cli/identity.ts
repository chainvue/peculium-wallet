/**
 * `peculium identity create` — register a VerusID for the agent, daemon-free
 * (E6). Uses the wallet's own key + funds; burns the protocol registration
 * fee (100 native without referral, 80 with one). Authorities must be COLD
 * identities you control elsewhere — see docs/IDENTITY-RUNBOOK.md.
 */

import { formatAmount, VerusClient } from "verus-rpc";

import { provisionIdentity } from "../identity-provision.js";
import { readKeystoreFile, unlockKeystore } from "../keystore.js";
import { CliUsageError, parseArgs, requireValue, type CliContext } from "./context.js";

/** Resolve an authority argument (i-address or name@) to an i-address. */
async function resolveAuthority(
  ctx: CliContext,
  what: string,
  value: string,
): Promise<string> {
  if (value.startsWith("i")) {
    return value;
  }
  const name = value.endsWith("@") ? value : `${value}@`;
  try {
    const client = ctx.makeClient();
    const result = (await client.call("getidentity", [name])) as {
      identity?: { identityaddress?: string };
    };
    const address = result.identity?.identityaddress;
    if (address === undefined) {
      throw new Error("no identityaddress in response");
    }
    ctx.err(`${what} ${name} → ${address}`);
    return address;
  } catch (error) {
    throw new CliUsageError(
      `${what} "${value}" could not be resolved on-chain: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Build the registration-node client, with optional basic-auth from env. */
function makeRegistrationClient(url: string, ctx: CliContext): VerusClient {
  const user = ctx.env["PECULIUM_REGISTRATION_NODE_USER"];
  const pass = ctx.env["PECULIUM_REGISTRATION_NODE_PASS"];
  return user !== undefined && pass !== undefined
    ? new VerusClient({ url, user, pass })
    : new VerusClient({ url });
}

export async function cmdIdentity(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  if (positionals[0] !== "create" || positionals[1] === undefined) {
    throw new CliUsageError(
      "usage: peculium identity create <name> --revocation <id> --recovery <id> " +
        "[--referral <id>] [--registration-node <url>] [--yes]",
    );
  }
  const name = positionals[1];
  const revocation = await resolveAuthority(ctx, "revocation authority", requireValue(flags, "revocation"));
  const recovery = await resolveAuthority(ctx, "recovery authority", requireValue(flags, "recovery"));
  const referralRaw = flags.get("referral");
  const referral =
    typeof referralRaw === "string"
      ? await resolveAuthority(ctx, "referral", referralRaw)
      : undefined;

  const keystore = readKeystoreFile(ctx.dir);
  const burn = referral !== undefined ? 80_0000_0000n : 100_0000_0000n;
  ctx.err(``);
  ctx.err(`Registering ${name}@ on ${ctx.chain}:`);
  ctx.err(`  primary address:      ${keystore.address} (this wallet's key)`);
  ctx.err(`  revocation authority: ${revocation}`);
  ctx.err(`  recovery authority:   ${recovery}`);
  ctx.err(
    `  cost: BURNS ${formatAmount(burn)} ${ctx.chain} from this wallet (plus tx fees). ` +
      `This is protocol behavior, not a fee you can get back.`,
  );
  if (!flags.has("yes")) {
    const answer = await ctx.promptVisible(`Type the identity name to proceed:`);
    if (answer !== name) {
      ctx.err(`name mismatch — aborted, nothing was sent`);
      return 1;
    }
  }

  // KNOWN BLOCKER: the registration broadcast currently fails on ANY node
  // ("Transaction has absurd fees" — an identity-specific guard allowhighfees
  // does not lift; see RISKS.md → Etappe 6). --registration-node lets the
  // operator target their own node for when the broadcast path is unblocked;
  // it does NOT work around the guard today.
  const registrationNode = flags.get("registration-node");
  ctx.err(``);
  ctx.err(
    `WARNING: identity registration is a KNOWN BLOCKER — the registration ` +
      `broadcast is rejected with "Transaction has absurd fees" on every node ` +
      `(an identity-specific guard that allowhighfees does not lift). The ` +
      `commitment will be sent, but registration will fail. See ` +
      `docs/IDENTITY-RUNBOOK.md / RISKS.md before proceeding.`,
  );

  const passphrase =
    ctx.env["PECULIUM_KEYSTORE_PASSPHRASE"] ??
    (await ctx.promptHidden("Keystore passphrase (input hidden):"));
  const wif = unlockKeystore(keystore, passphrase);

  const result = await provisionIdentity({
    client: ctx.makeClient(),
    ...(typeof registrationNode === "string"
      ? { registrationClient: makeRegistrationClient(registrationNode, ctx) }
      : {}),
    chain: ctx.chain,
    wif,
    address: keystore.address,
    name,
    revocationAuthority: revocation,
    recoveryAuthority: recovery,
    ...(referral !== undefined ? { referral } : {}),
    onStatus: (line) => ctx.err(`  ${line}`),
  });

  ctx.out(`identity registered: ${result.identityName} (${result.identityAddress})`);
  ctx.out(`  commitment tx:   ${result.commitmentTxid}`);
  ctx.out(`  registration tx: ${result.registrationTxid}`);
  ctx.out(``);
  ctx.out(`Next steps (docs/IDENTITY-RUNBOOK.md):`);
  ctx.out(`  - verify the authorities from a wallet holding them`);
  ctx.out(`  - rehearse revoke→recover BEFORE trusting the identity with funds`);
  ctx.out(`  - the agent keeps spending from ${keystore.address} in v1`);
  return 0;
}
