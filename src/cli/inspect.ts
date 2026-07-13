/**
 * Read-only operator commands: `status`, `history`, `doctor`.
 *
 * All three work while the MCP server is RUNNING: they read policy/state
 * directly and use the lock-free ledger snapshot (advisory, point in time).
 * `doctor` exits with the number of failed checks — scriptable.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { formatAmount } from "verus-rpc";

import { auditLineSchema } from "../audit.js";
import { readKeystoreFile, unlockKeystore } from "../keystore.js";
import { loadPolicy } from "../policy/load.js";
import { readState } from "../state-io.js";
import { parseArgs, readLedgerSnapshot, type CliContext } from "./context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function cmdStatus(_argv: readonly string[], ctx: CliContext): number {
  const loaded = loadPolicy(ctx.dir);
  const policy = loaded.policy;
  ctx.out(`Peculium wallet — ${ctx.dir}`);
  ctx.out(``);
  ctx.out(`policy hash:   ${loaded.policyHash.slice(0, 16)}…`);
  ctx.out(`network:       ${policy.network}`);
  ctx.out(`agent address: ${policy.agentAddress} (${policy.addressMode})`);
  ctx.out(`arm required:  ${policy.armRequired ? "yes" : "no"}`);

  const state = readState(ctx.dir);
  const now = ctx.clock();
  if (state.armedUntil !== null && new Date(state.armedUntil) > now) {
    ctx.out(`armed until:   ${state.armedUntil}`);
  } else if (policy.armRequired) {
    ctx.out(`armed:         NO — spends are denied until \`peculium arm\``);
  }
  if (state.grant !== null && new Date(state.grant.expiresAt) > now) {
    ctx.out(
      `grant:         ${formatAmount(state.grant.remainingSats)} ${state.grant.currency} ` +
        `remaining, expires ${state.grant.expiresAt}`,
    );
  }

  const snapshot = readLedgerSnapshot(ctx.dir);
  ctx.out(``);
  ctx.out(`caps (per currency) and trailing-24h usage:`);
  for (const entry of policy.currencies) {
    const spentDay = snapshot.rows
      .filter(
        (row) =>
          row.currency === entry.currency &&
          row.countsAsSpent &&
          now.getTime() - new Date(row.pendingAt).getTime() <= DAY_MS,
      )
      .reduce((sum, row) => sum + row.amountSats, 0n);
    const total = snapshot.rows
      .filter((row) => row.currency === entry.currency && row.countsAsSpent)
      .reduce((sum, row) => sum + row.amountSats, 0n);
    ctx.out(
      `  ${entry.currency}: tx ≤ ${formatAmount(entry.maxPerTxSats)}, ` +
        `24h ${formatAmount(spentDay)}/${formatAmount(entry.maxPerDaySats)}, ` +
        `total ${formatAmount(total)}/${formatAmount(entry.maxTotalSats)}`,
    );
  }

  ctx.out(``);
  ctx.out(`facilitators (${policy.facilitators.length}):`);
  for (const entry of policy.facilitators) {
    ctx.out(
      `  ${entry.name} → ${entry.address} [${entry.currency}] ` +
        `tx ≤ ${formatAmount(entry.maxPerTxSats)}, day ≤ ${formatAmount(entry.maxPerDaySats)}` +
        `${entry.autoApprove ? ", auto-approve" : ""}`,
    );
  }
  ctx.out(`recipients (${policy.recipients.length}):`);
  for (const entry of policy.recipients) {
    ctx.out(`  ${entry.name} → ${entry.address}`);
  }

  const ambiguous = snapshot.rows.filter((row) => row.state === "ambiguous");
  const inFlight = snapshot.rows.filter(
    (row) => row.state === "pending" || row.state === "broadcast",
  );
  ctx.out(``);
  ctx.out(
    `ledger: ${snapshot.rows.length} request(s), ${inFlight.length} in flight, ` +
      `${ambiguous.length} ambiguous${snapshot.tornTail ? ", TORN TAIL" : ""}` +
      `${snapshot.corrupt !== null ? `, CORRUPT (${snapshot.corrupt})` : ""}`,
  );
  for (const row of ambiguous) {
    ctx.out(
      `  AMBIGUOUS ${row.requestId}: ${formatAmount(row.amountSats)} ${row.currency} → ` +
        `${row.recipientName} — resolve with \`peculium resolve\``,
    );
  }
  return 0;
}

export function cmdHistory(argv: readonly string[], ctx: CliContext): number {
  const { flags } = parseArgs(argv);
  const limitRaw = flags.get("limit");
  const limit = typeof limitRaw === "string" ? Number(limitRaw) : 20;

  const snapshot = readLedgerSnapshot(ctx.dir);
  const rows = [...snapshot.rows]
    .sort((a, b) => a.pendingAt.localeCompare(b.pendingAt))
    .slice(-limit);
  ctx.out(`last ${rows.length} money request(s):`);
  for (const row of rows) {
    ctx.out(
      `  ${row.pendingAt}  ${row.kind.padEnd(5)} ${formatAmount(row.amountSats)} ` +
        `${row.currency} → ${row.recipientName}  [${row.state}]` +
        `${row.txid !== null ? `  ${row.txid.slice(0, 12)}…` : ""}`,
    );
  }

  // Audit narrative (best effort — the file may be absent or rotated).
  try {
    const raw = fs.readFileSync(path.join(ctx.dir, "audit.jsonl"), "utf8");
    const lines = raw.split("\n").filter((line) => line !== "");
    const tail = lines.slice(-limit);
    ctx.out(``);
    ctx.out(`last ${tail.length} audit event(s):`);
    for (const line of tail) {
      try {
        const event = auditLineSchema.parse(JSON.parse(line));
        const extra =
          event.event === "intent-denied"
            ? ` ${event.requestId} (${event.reasonCode})`
            : "requestId" in event
              ? ` ${event.requestId}`
              : "";
        ctx.out(`  ${event.at}  ${event.event}${extra}`);
      } catch {
        ctx.out(`  (unparsable audit line)`);
      }
    }
  } catch {
    ctx.out(`(no audit trail found)`);
  }
  return 0;
}

export async function cmdDoctor(_argv: readonly string[], ctx: CliContext): Promise<number> {
  let failures = 0;
  const ok = (line: string): void => ctx.out(`  ok    ${line}`);
  const warn = (line: string): void => ctx.out(`  warn  ${line}`);
  const fail = (line: string): void => {
    failures += 1;
    ctx.out(`  FAIL  ${line}`);
  };

  ctx.out(`peculium doctor — ${ctx.dir}`);

  // 1. Policy parses and respects the compiled hard caps.
  let agentAddress: string | null = null;
  try {
    const loaded = loadPolicy(ctx.dir);
    agentAddress = loaded.policy.agentAddress;
    ok(`policy.json valid (hash ${loaded.policyHash.slice(0, 16)}…, network ${loaded.policy.network})`);
  } catch (error) {
    fail(`policy.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. Keystore present, address consistent, unlockable when possible.
  // Identity mode (i-address agentAddress): the keystore holds the
  // identity's PRIMARY key, so the addresses differ BY DESIGN — control is
  // verified on-chain in the node section below (same rule the backend
  // enforces at spend time).
  let keystoreAddress: string | null = null;
  try {
    const keystore = readKeystoreFile(ctx.dir);
    keystoreAddress = keystore.address;
    if (agentAddress !== null && agentAddress.startsWith("i")) {
      ok(`keystore.json present (primary key ${keystore.address} for identity ${agentAddress})`);
    } else if (agentAddress !== null && keystore.address !== agentAddress) {
      fail(`keystore address ${keystore.address} != policy agentAddress ${agentAddress}`);
    } else {
      ok(`keystore.json present (address ${keystore.address})`);
    }
    const passphrase = ctx.env["PECULIUM_KEYSTORE_PASSPHRASE"];
    if (passphrase === undefined || passphrase === "") {
      warn(`PECULIUM_KEYSTORE_PASSPHRASE not set — unlock not tested (spends would fail)`);
    } else {
      try {
        unlockKeystore(keystore, passphrase);
        ok(`keystore unlocks with the configured passphrase`);
      } catch {
        fail(`keystore does NOT unlock with PECULIUM_KEYSTORE_PASSPHRASE`);
      }
    }
  } catch (error) {
    fail(`keystore: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 3. State file.
  try {
    readState(ctx.dir);
    ok(`state.json valid`);
  } catch (error) {
    fail(`state.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 4. Ledger snapshot (lock-free).
  const snapshot = readLedgerSnapshot(ctx.dir);
  if (snapshot.corrupt !== null) {
    fail(`ledger.jsonl corrupt: ${snapshot.corrupt}`);
  } else if (snapshot.tornTail) {
    fail(`ledger.jsonl has a torn tail — run \`peculium resolve --repair-tail\``);
  } else {
    ok(`ledger.jsonl clean (${snapshot.rows.length} request(s))`);
  }
  const ambiguous = snapshot.rows.filter((row) => row.state === "ambiguous");
  if (ambiguous.length > 0) {
    fail(
      `${ambiguous.length} ambiguous request(s) still count against the caps — ` +
        `settle them with \`peculium resolve\``,
    );
  }

  // 5. Node reachability + chain sanity + funding + fragmentation.
  try {
    const client = ctx.makeClient();
    // Untyped call on purpose: public gateways vary in which getinfo fields
    // they include, and doctor only needs blocks/name/testnet.
    const info = (await client.call("getinfo", [])) as {
      blocks?: number;
      name?: string;
      testnet?: boolean;
    };
    const chainOk = info.testnet === true || String(info.name ?? "").includes("VRSCTEST");
    if (ctx.chain === "VRSCTEST" && !chainOk) {
      fail(`node at ${ctx.nodeUrl} does not look like ${ctx.chain} (name ${String(info.name)})`);
    } else {
      ok(`node reachable (${ctx.nodeUrl}, height ${String(info.blocks)})`);
    }
    if (agentAddress !== null) {
      const balance = await client.addressIndex.getAddressBalance({ addresses: [agentAddress] });
      if (balance.balance <= 0n) {
        warn(`agent address holds 0 — fund it before expecting spends to work`);
      } else {
        ok(`agent address funded: ${formatAmount(balance.balance)} ${ctx.chain}`);
      }
      const utxos = await client.addressIndex.getAddressUtxos({ addresses: [agentAddress] });
      if (utxos.length > 20) {
        warn(
          `${utxos.length} UTXOs on the agent address — heavily fragmented wallets ` +
            `build larger transactions (higher fees); consider consolidating`,
        );
      }
      // Identity mode: verify on-chain control — the exact rule the backend
      // enforces at spend time (active, single-sig, keystore key primary).
      if (agentAddress.startsWith("i") && keystoreAddress !== null) {
        const lookup = (await client.call("getidentity", [agentAddress])) as {
          status?: string;
          identity?: { primaryaddresses?: string[]; minimumsignatures?: number };
        };
        const primaries = lookup.identity?.primaryaddresses ?? [];
        const minSigs = lookup.identity?.minimumsignatures ?? 0;
        if (lookup.status !== "active") {
          fail(`agent identity ${agentAddress} is not active (status ${String(lookup.status)}) — spends will refuse`);
        } else if (minSigs !== 1) {
          fail(`agent identity requires ${minSigs} signatures — only single-sig is supported in v1`);
        } else if (!primaries.includes(keystoreAddress)) {
          fail(
            `keystore key ${keystoreAddress} is NOT a primary address of ${agentAddress} — ` +
              `recovered/rotated identity? Spends will refuse`,
          );
        } else {
          ok(`identity control verified on-chain (active, single-sig, keystore key is primary)`);
        }
      }
    }
  } catch (error) {
    fail(`node ${ctx.nodeUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 6. Elicitation capability can only be judged inside an MCP session.
  ctx.out(
    `  note  elicitation support depends on the connected MCP host — verify in the host ` +
      `(Claude Code >= 2.1.76 supports it; hosts without it get fail-closed denies)`,
  );

  ctx.out(failures === 0 ? `all checks passed` : `${failures} check(s) FAILED`);
  return failures;
}

/**
 * `peculium report` — the human twin of wallet_spending_report: spend
 * aggregates + recent requests from the lock-free ledger snapshot.
 * Options: --recipient <name>, --kind <topup|send>, --since <hours>
 * (default 168 = 7 days), --group-by <day|recipient|kind>, --limit <n>.
 */
export function cmdReport(argv: readonly string[], ctx: CliContext): number {
  const { flags } = parseArgs(argv);
  const sinceRaw = flags.get("since");
  const sinceHours = typeof sinceRaw === "string" ? Number(sinceRaw) : 168;
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
    throw new Error(`--since must be a positive number of hours, got ${String(sinceRaw)}`);
  }
  const groupByRaw = flags.get("group-by");
  const groupBy =
    groupByRaw === "recipient" || groupByRaw === "kind" ? groupByRaw : ("day" as const);
  const recipient = typeof flags.get("recipient") === "string" ? String(flags.get("recipient")) : null;
  const kindFilter = flags.get("kind");
  const limitRaw = flags.get("limit");
  const limit = typeof limitRaw === "string" ? Math.max(1, Number(limitRaw) || 20) : 20;

  const now = ctx.clock();
  const sinceMs = now.getTime() - sinceHours * 60 * 60 * 1000;
  const snapshot = readLedgerSnapshot(ctx.dir);
  if (snapshot.corrupt !== null) {
    ctx.err(`WARNING: ledger snapshot truncated (${snapshot.corrupt})`);
  }
  const rows = snapshot.rows
    .filter((row) => new Date(row.pendingAt).getTime() >= sinceMs)
    .filter((row) => (recipient === null ? true : row.recipientName === recipient))
    .filter((row) => (typeof kindFilter !== "string" ? true : row.kind === kindFilter))
    .sort((a, b) => (a.pendingAt < b.pendingAt ? 1 : -1));

  ctx.out(`spending report — last ${sinceHours}h${recipient !== null ? `, recipient ${recipient}` : ""}`);
  ctx.out(``);

  const buckets = new Map<
    string,
    { bucket: string; currency: string; spent: bigint; txCount: number; failed: number }
  >();
  const keyOf = (row: (typeof rows)[number]): string =>
    groupBy === "day"
      ? row.pendingAt.slice(0, 10)
      : groupBy === "recipient"
        ? row.recipientName
        : row.kind;
  let totalSpent = 0n;
  for (const row of rows) {
    const key = `${keyOf(row)}|${row.currency}`;
    const bucket = buckets.get(key) ?? {
      bucket: keyOf(row),
      currency: row.currency,
      spent: 0n,
      txCount: 0,
      failed: 0,
    };
    if (row.countsAsSpent) {
      bucket.spent += row.amountSats;
      bucket.txCount += 1;
      totalSpent += row.amountSats;
    } else {
      bucket.failed += 1;
    }
    buckets.set(key, bucket);
  }
  for (const bucket of [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))) {
    ctx.out(
      `  ${bucket.bucket}  ${formatAmount(bucket.spent)} ${bucket.currency}` +
        `  (${bucket.txCount} tx${bucket.failed > 0 ? `, ${bucket.failed} failed` : ""})`,
    );
  }
  if (buckets.size === 0) {
    ctx.out(`  (no money requests in the window)`);
  }
  ctx.out(``);
  ctx.out(`total counted as spent: ${formatAmount(totalSpent)}`);
  ctx.out(``);
  ctx.out(`recent request(s):`);
  for (const row of rows.slice(0, limit)) {
    ctx.out(
      `  ${row.pendingAt}  ${row.kind} ${formatAmount(row.amountSats)} ${row.currency} → ` +
        `${row.recipientName}  [${row.state}]  ${row.requestId}` +
        `${row.txid !== null ? `  ${row.txid.slice(0, 12)}…` : ""}`,
    );
  }
  if (rows.length === 0) {
    ctx.out(`  (none)`);
  }
  return 0;
}
