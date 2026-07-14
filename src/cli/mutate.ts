/**
 * State- and policy-mutating operator commands: `grant`, `arm`, `disarm`,
 * `allow`, `revoke`, `set`, `resolve`.
 *
 * Policy edits go through writePolicyInput, which re-runs the REAL schema +
 * hard-cap validation before anything reaches disk — a CLI edit can never
 * produce a policy the engine would refuse to load. Every successful policy
 * change is audited with old/new hash.
 */

import { formatAmount } from "verus-rpc";

import { AuditLog } from "../audit.js";
import { SpendLedger } from "../ledger/ledger.js";
import { loadPolicy } from "../policy/load.js";
import { readState, writeState } from "../state-io.js";
import {
  CliUsageError,
  parseArgs,
  parseDuration,
  parsePositiveAmount,
  readPolicyInput,
  requireValue,
  writePolicyInput,
  type CliContext,
} from "./context.js";

/** Run a policy mutation with before/after hashes audited. */
function editPolicy(
  ctx: CliContext,
  command: string,
  mutate: (input: ReturnType<typeof readPolicyInput>) => void,
): void {
  const before = loadPolicy(ctx.dir);
  const input = readPolicyInput(ctx.dir);
  mutate(input);
  const after = writePolicyInput(ctx.dir, input, ctx.clock);
  const audit = AuditLog.open(ctx.dir, { clock: ctx.clock });
  audit.write({
    event: "policy-changed",
    oldHash: before.policyHash,
    newHash: after.policyHash,
    command,
  });
  audit.close();
  ctx.out(`policy updated (${before.policyHash.slice(0, 12)}… → ${after.policyHash.slice(0, 12)}…)`);
}

// ------------------------------------------------------------------- grant

export function cmdGrant(argv: readonly string[], ctx: CliContext): number {
  const { positionals, flags } = parseArgs(argv);
  const state = readState(ctx.dir);

  if (flags.has("revoke")) {
    writeState(ctx.dir, { ...state, grant: null });
    ctx.out(`grant revoked`);
    return 0;
  }

  const amountText = positionals[0];
  if (amountText === undefined) {
    throw new CliUsageError("usage: peculium grant <amount> [--currency C] [--ttl 2h] | --revoke");
  }
  const sats = parsePositiveAmount(amountText, "grant amount");
  const currency = typeof flags.get("currency") === "string" ? (flags.get("currency") as string) : ctx.chain;
  const ttlMs = parseDuration(typeof flags.get("ttl") === "string" ? (flags.get("ttl") as string) : "2h");
  const expiresAt = new Date(ctx.clock().getTime() + ttlMs).toISOString();

  writeState(ctx.dir, {
    ...state,
    grant: { currency, remainingSats: sats, expiresAt },
  });
  ctx.out(`grant active: ${formatAmount(sats)} ${currency}, expires ${expiresAt}`);
  ctx.out(`(a grant is an ADDITIONAL ceiling on top of caps, depleted per spend)`);
  return 0;
}

// -------------------------------------------------------------- arm/disarm

export function cmdArm(argv: readonly string[], ctx: CliContext): number {
  const { positionals } = parseArgs(argv);
  const minutes = positionals[0] !== undefined ? Number(positionals[0]) : 60;
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60) {
    throw new CliUsageError("usage: peculium arm [minutes 1..1440]");
  }
  const state = readState(ctx.dir);
  const armedUntil = new Date(ctx.clock().getTime() + minutes * 60_000).toISOString();
  writeState(ctx.dir, { ...state, armedUntil });
  ctx.out(`armed until ${armedUntil}`);
  return 0;
}

export function cmdDisarm(_argv: readonly string[], ctx: CliContext): number {
  const state = readState(ctx.dir);
  writeState(ctx.dir, { ...state, armedUntil: null });
  ctx.out(`disarmed — spends are denied while armRequired is true`);
  return 0;
}

// ------------------------------------------------------------ allow/revoke

export function cmdAllow(argv: readonly string[], ctx: CliContext): number {
  const { positionals, flags } = parseArgs(argv);
  const [kind, name, address] = positionals;
  if (kind === "recipient") {
    if (name === undefined || address === undefined) {
      throw new CliUsageError("usage: peculium allow recipient <name> <address>");
    }
    editPolicy(ctx, `allow recipient ${name}`, (input) => {
      input.recipients.push({ name, address });
    });
    ctx.out(`recipient "${name}" → ${address} allowlisted (sends always need confirmation)`);
    return 0;
  }
  if (kind === "service") {
    if (name === undefined) {
      throw new CliUsageError(
        "usage: peculium allow service <name> --origin <https://api.…> --facilitator <name> " +
          "--max-per-call X --max-per-day Y [--currency C] [--auto-approve]",
      );
    }
    const originRaw = flags.get("origin") ?? flags.get("host");
    if (typeof originRaw !== "string") {
      throw new CliUsageError("--origin (or --host) requires a value");
    }
    // --host accepts a bare hostname; default it to https.
    const origin = originRaw.includes("://") ? originRaw : `https://${originRaw}`;
    const facilitator = requireValue(flags, "facilitator");
    const maxPerCall = requireValue(flags, "max-per-call");
    const maxPerDay = requireValue(flags, "max-per-day");
    parsePositiveAmount(maxPerCall, "--max-per-call");
    parsePositiveAmount(maxPerDay, "--max-per-day");
    const currency =
      typeof flags.get("currency") === "string" ? (flags.get("currency") as string) : ctx.chain;
    const autoApprove = flags.has("auto-approve");
    editPolicy(ctx, `allow service ${name}`, (input) => {
      input.services = [
        ...(input.services ?? []),
        {
          name,
          origin,
          facilitator,
          currency,
          maxPricePerCall: maxPerCall,
          maxPerDay,
          autoApprove,
        },
      ];
    });
    ctx.out(
      `service "${name}" → ${origin} [${currency}] via facilitator "${facilitator}", ` +
        `call ≤ ${maxPerCall}, day ≤ ${maxPerDay}` +
        `${autoApprove ? ", auto-approve" : " (every call asks the human)"}`,
    );
    ctx.out(`(paid-fetch burns PREPAID credit at "${facilitator}" — top it up to use this)`);
    return 0;
  }
  if (kind === "facilitator") {
    if (name === undefined || address === undefined) {
      throw new CliUsageError(
        "usage: peculium allow facilitator <name> <address> --max-per-tx X --max-per-day Y " +
          "[--currency C] [--auto-approve] [--api-url <https://…>]",
      );
    }
    const currency =
      typeof flags.get("currency") === "string" ? (flags.get("currency") as string) : ctx.chain;
    const maxPerTx = requireValue(flags, "max-per-tx");
    const maxPerDay = requireValue(flags, "max-per-day");
    parsePositiveAmount(maxPerTx, "--max-per-tx");
    parsePositiveAmount(maxPerDay, "--max-per-day");
    const autoApprove = flags.has("auto-approve");
    const apiUrlRaw = flags.get("api-url");
    const apiUrl = typeof apiUrlRaw === "string" ? apiUrlRaw : undefined;
    editPolicy(ctx, `allow facilitator ${name}`, (input) => {
      input.facilitators.push({
        name,
        address,
        currency,
        maxPerTx,
        maxPerDay,
        autoApprove,
        ...(apiUrl !== undefined ? { apiUrl } : {}),
      });
    });
    ctx.out(
      `facilitator "${name}" → ${address} [${currency}] tx ≤ ${maxPerTx}, day ≤ ${maxPerDay}` +
        `${autoApprove ? ", auto-approve" : " (confirmation required)"}` +
        `${apiUrl !== undefined ? `, api ${apiUrl}` : ""}`,
    );
    return 0;
  }
  throw new CliUsageError("usage: peculium allow <recipient|facilitator|service> …");
}

export function cmdRevoke(argv: readonly string[], ctx: CliContext): number {
  const { positionals, flags } = parseArgs(argv);
  const [kind, name] = positionals;
  if (name === undefined || (kind !== "recipient" && kind !== "facilitator" && kind !== "service")) {
    throw new CliUsageError(
      "usage: peculium revoke <recipient|facilitator|service> <name> [--currency C]",
    );
  }
  const currency = flags.get("currency");
  let removed = 0;
  editPolicy(ctx, `revoke ${kind} ${name}`, (input) => {
    if (kind === "recipient") {
      const before = input.recipients.length;
      input.recipients = input.recipients.filter((entry) => entry.name !== name);
      removed = before - input.recipients.length;
    } else if (kind === "service") {
      const services = input.services ?? [];
      input.services = services.filter((entry) => entry.name !== name);
      removed = services.length - input.services.length;
    } else {
      const before = input.facilitators.length;
      input.facilitators = input.facilitators.filter(
        (entry) =>
          entry.name !== name || (typeof currency === "string" && entry.currency !== currency),
      );
      removed = before - input.facilitators.length;
    }
    if (removed === 0) {
      throw new CliUsageError(`no ${kind} entry named "${name}"${typeof currency === "string" ? ` for ${currency}` : ""}`);
    }
  });
  ctx.out(`${kind} "${name}": ${removed} entr${removed === 1 ? "y" : "ies"} removed`);
  return 0;
}

// --------------------------------------------------------------------- set

export function cmdSet(argv: readonly string[], ctx: CliContext): number {
  const { positionals, flags } = parseArgs(argv);
  const what = positionals[0];

  if (what === "cap") {
    const currency = positionals[1];
    if (currency === undefined) {
      throw new CliUsageError(
        "usage: peculium set cap <currency> --per-tx X --per-day Y --total Z " +
          "(all three; remove a currency's entry to make it unspendable)",
      );
    }
    const perTx = requireValue(flags, "per-tx");
    const perDay = requireValue(flags, "per-day");
    const total = requireValue(flags, "total");
    for (const [label, value] of [["--per-tx", perTx], ["--per-day", perDay], ["--total", total]] as const) {
      parsePositiveAmount(value, label);
    }
    editPolicy(ctx, `set cap ${currency}`, (input) => {
      const entry = { currency, maxPerTx: perTx, maxPerDay: perDay, maxTotal: total };
      const index = input.currencies.findIndex((c) => c.currency === currency);
      if (index === -1) {
        input.currencies.push(entry);
      } else {
        input.currencies[index] = entry;
      }
    });
    ctx.out(`cap for ${currency}: tx ≤ ${perTx}, 24h ≤ ${perDay}, total ≤ ${total}`);
    return 0;
  }

  if (what === "rate") {
    editPolicy(ctx, "set rate", (input) => {
      const perHour = flags.get("max-per-hour");
      const minInterval = flags.get("min-interval");
      const dedupe = flags.get("dedupe-window");
      if (typeof perHour === "string") {
        input.rate.maxSendsPerHour = Number(perHour);
      }
      if (typeof minInterval === "string") {
        input.rate.minSecondsBetweenSends = Number(minInterval);
      }
      if (typeof dedupe === "string") {
        input.rate.dedupeWindowSeconds = Number(dedupe);
      }
    });
    ctx.out(`rate limits updated`);
    return 0;
  }

  if (what === "confirm-timeout") {
    const seconds = Number(positionals[1]);
    editPolicy(ctx, "set confirm-timeout", (input) => {
      input.confirmTimeoutSeconds = seconds;
    });
    ctx.out(`confirm timeout: ${seconds}s`);
    return 0;
  }

  if (what === "arm-required") {
    const value = positionals[1];
    if (value !== "true" && value !== "false") {
      throw new CliUsageError("usage: peculium set arm-required <true|false>");
    }
    editPolicy(ctx, `set arm-required ${value}`, (input) => {
      input.armRequired = value === "true";
    });
    ctx.out(`armRequired = ${value}`);
    return 0;
  }

  throw new CliUsageError("usage: peculium set <cap|rate|confirm-timeout|arm-required> …");
}

// ----------------------------------------------------------------- resolve

export async function cmdResolve(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { positionals, flags } = parseArgs(argv);

  if (flags.has("repair-tail")) {
    return repairTail(ctx, flags.has("yes"));
  }

  const requestId = positionals[0];
  const spentTxid = flags.get("spent");
  const notSpent = flags.has("not-spent");
  // A bare --spent (no txid) is valid for OFF-CHAIN paid-fetch rows: the
  // evidence is the facilitator's ledger statement, not a transaction.
  if (requestId === undefined || flags.has("spent") === notSpent) {
    throw new CliUsageError(
      "usage: peculium resolve <requestId> (--spent [txid] | --not-spent)  |  " +
        "peculium resolve --repair-tail [--yes]",
    );
  }

  // Resolution needs the REAL ledger (lock + state machine). If the MCP
  // server is running it holds the lock — stop it first; that is correct,
  // not an inconvenience: two writers on one money log is never safe.
  const ledger = SpendLedger.open(ctx.dir, { clock: ctx.clock });
  try {
    const outcome = notSpent ? ("not-spent" as const) : ("spent" as const);
    const txid = typeof spentTxid === "string" ? spentTxid : null;
    // On-chain rows resolve as spent only WITH the txid as evidence; the
    // bare form is reserved for off-chain paid-fetch rows (no txid exists).
    if (outcome === "spent" && txid === null) {
      const row = ledger.getOutcome(requestId);
      if (row === null || row.kind !== "paid-fetch") {
        throw new CliUsageError(
          `resolving ${requestId} as spent needs the txid (--spent <txid>) — ` +
            `only off-chain paid-fetch rows resolve without one`,
        );
      }
    }
    ledger.recordResolved(requestId, outcome, txid, "cli-resolve");
    const audit = AuditLog.open(ctx.dir, { clock: ctx.clock });
    audit.write({ event: "ledger-recovery", requestId, action: `resolved-${outcome}` });
    audit.close();
    ctx.out(
      outcome === "not-spent"
        ? `${requestId} resolved as NOT spent — the reservation is released`
        : txid === null
          ? `${requestId} resolved as spent (off-chain — no txid)`
          : `${requestId} resolved as spent (txid ${txid.slice(0, 12)}…)`,
    );
    return 0;
  } finally {
    ledger.close();
  }
}

/** Inspect and (with --yes) truncate a torn final line of ledger.jsonl. */
async function repairTail(ctx: CliContext, yes: boolean): Promise<number> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const ledgerPath = path.join(ctx.dir, "ledger.jsonl");
  const content = fs.readFileSync(ledgerPath, "utf8");
  if (content === "" || content.endsWith("\n")) {
    ctx.out(`ledger.jsonl has no torn tail — nothing to repair`);
    return 0;
  }
  const lastNewline = content.lastIndexOf("\n");
  const torn = content.slice(lastNewline + 1);
  ctx.out(`torn final line (${torn.length} bytes):`);
  ctx.out(`  ${torn.slice(0, 200)}${torn.length > 200 ? "…" : ""}`);
  if (!yes) {
    const answer = await ctx.promptVisible(
      "Truncate this torn line? The request it belonged to will replay as `ambiguous` " +
        "on next open (fail closed). [y/N]",
    );
    if (!answer.toLowerCase().startsWith("y")) {
      ctx.out(`aborted — nothing changed`);
      return 1;
    }
  }
  fs.copyFileSync(ledgerPath, `${ledgerPath}.pre-repair-${Date.now()}`);
  fs.truncateSync(ledgerPath, lastNewline + 1);
  ctx.out(`torn tail removed (backup written next to the ledger)`);
  return 0;
}
