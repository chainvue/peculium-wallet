// CLI units: every command driven through an in-memory CliContext — no
// child processes, scripted prompts, MockTransport node, fixed clock.
// The E5 gates: units per command, init dry-run, doctor against broken
// fixtures (bad node, bad policy, locked keystore).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MockTransport, VerusClient } from "verus-rpc";
import { afterEach, describe, expect, it } from "vitest";

import { readKeystoreFile } from "../src/keystore.js";
import { SpendLedger } from "../src/ledger/ledger.js";
import { loadPolicy } from "../src/policy/load.js";
import { readState } from "../src/state-io.js";
import { readLedgerSnapshot, type CliContext } from "../src/cli/context.js";
import { cmdInit } from "../src/cli/init.js";
import { cmdDoctor, cmdHistory, cmdReport, cmdStatus } from "../src/cli/inspect.js";
import { cmdBackup, cmdExportKey, cmdRestore } from "../src/cli/keyops.js";
import {
  cmdAllow,
  cmdArm,
  cmdDisarm,
  cmdGrant,
  cmdResolve,
  cmdRevoke,
  cmdSet,
} from "../src/cli/mutate.js";
import { runCli } from "../src/cli/run.js";
import { send } from "./helpers.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const PASSPHRASE = "cli-test-passphrase";

interface Harness {
  ctx: CliContext;
  dir: string;
  out: string[];
  err: string[];
  transport: MockTransport;
}

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function makeHarness(opts: { prompts?: string[]; env?: Record<string, string> } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-cli-"));
  dirs.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const prompts = [...(opts.prompts ?? [])];
  const transport = new MockTransport();
  const nextPrompt = (): Promise<string> => {
    const answer = prompts.shift();
    if (answer === undefined) {
      throw new Error("test asked for a prompt answer but none was scripted");
    }
    return Promise.resolve(answer);
  };
  const ctx: CliContext = {
    dir,
    chain: "VRSCTEST",
    nodeUrl: "http://mock-node",
    env: opts.env ?? {},
    clock: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    promptVisible: nextPrompt,
    promptHidden: nextPrompt,
    makeClient: () => new VerusClient({ transport }),
  };
  return { ctx, dir, out, err, transport };
}

/** A provisioned wallet dir (starter mode, env passphrase). */
async function initialized(
  opts: { env?: Record<string, string> } = {},
): Promise<Harness & { address: string }> {
  const harness = makeHarness({
    env: { PECULIUM_KEYSTORE_PASSPHRASE: PASSPHRASE, ...(opts.env ?? {}) },
  });
  await cmdInit(["--starter"], harness.ctx);
  const address = readKeystoreFile(harness.dir).address;
  return { ...harness, address };
}

describe("init", () => {
  it("--dry-run prints the plan and writes nothing", async () => {
    const { ctx, dir, out } = makeHarness();
    const code = await cmdInit(["--starter", "--dry-run"], ctx);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("[dry-run]");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("--starter provisions keystore, policy and state (env passphrase)", async () => {
    const harness = await initialized();
    const keystore = readKeystoreFile(harness.dir);
    expect(keystore.addressMode).toBe("starter-r-address");
    const loaded = loadPolicy(harness.dir);
    expect(loaded.policy.agentAddress).toBe(keystore.address);
    expect(loaded.policy.network).toBe("VRSCTEST");
    expect(readState(harness.dir).armedUntil).toBeNull();
    expect(harness.out.join("\n")).toContain("mcpServers");
    // The passphrase itself must never appear in the output.
    expect(harness.out.join("\n")).not.toContain(PASSPHRASE);
  });

  it("refuses to overwrite an existing keystore", async () => {
    const harness = await initialized();
    await expect(cmdInit(["--starter"], harness.ctx)).rejects.toThrow(/refusing to overwrite/);
  });

  it("requires exactly one mode", async () => {
    const { ctx } = makeHarness();
    await expect(cmdInit([], ctx)).rejects.toThrow(/exactly one mode/);
  });
});

describe("allow / revoke / set (policy edits)", () => {
  it("allowlists and revokes a recipient, audited", async () => {
    const harness = await initialized();
    cmdAllow(["recipient", "alice", "RAlice1111111111111111111111111111"], harness.ctx);
    expect(loadPolicy(harness.dir).policy.recipients).toHaveLength(1);
    const audit = fs.readFileSync(path.join(harness.dir, "audit.jsonl"), "utf8");
    expect(audit).toContain("policy-changed");
    cmdRevoke(["recipient", "alice"], harness.ctx);
    expect(loadPolicy(harness.dir).policy.recipients).toHaveLength(0);
  });

  it("rejects an edit that would produce an invalid policy (duplicate name)", async () => {
    const harness = await initialized();
    cmdAllow(["recipient", "alice", "RAlice1111111111111111111111111111"], harness.ctx);
    expect(() =>
      cmdAllow(["recipient", "alice", "ROther11111111111111111111111111111"], harness.ctx),
    ).toThrow(/duplicate/);
    // File unchanged.
    expect(loadPolicy(harness.dir).policy.recipients).toHaveLength(1);
  });

  it("adds a facilitator with budgets", async () => {
    const harness = await initialized();
    cmdAllow(
      [
        "facilitator",
        "demo",
        "RFacilitator1111111111111111111111",
        "--max-per-tx",
        "0.1",
        "--max-per-day",
        "0.5",
        "--auto-approve",
      ],
      harness.ctx,
    );
    const policy = loadPolicy(harness.dir).policy;
    expect(policy.facilitators[0]?.autoApprove).toBe(true);
    expect(policy.facilitators[0]?.currency).toBe("VRSCTEST");
  });

  it("set cap refuses to exceed the compiled hard caps", async () => {
    const harness = await initialized(); // starter mode: hard cap 1/5/25
    expect(() =>
      cmdSet(
        ["cap", "VRSCTEST", "--per-tx", "2", "--per-day", "5", "--total", "25"],
        harness.ctx,
      ),
    ).toThrow(/hard cap/);
    // and accepts an in-cap change
    cmdSet(["cap", "VRSCTEST", "--per-tx", "0.5", "--per-day", "2", "--total", "10"], harness.ctx);
    const entry = loadPolicy(harness.dir).policy.currencies[0];
    expect(entry?.maxPerTxSats).toBe(50_000_000n);
  });

  it("set arm-required toggles and set rate updates", async () => {
    const harness = await initialized();
    cmdSet(["arm-required", "true"], harness.ctx);
    expect(loadPolicy(harness.dir).policy.armRequired).toBe(true);
    cmdSet(["rate", "--max-per-hour", "3"], harness.ctx);
    expect(loadPolicy(harness.dir).policy.rate.maxSendsPerHour).toBe(3);
  });
});

describe("grant / arm / disarm (state edits)", () => {
  it("activates and revokes a grant", async () => {
    const harness = await initialized();
    cmdGrant(["0.5", "--ttl", "2h"], harness.ctx);
    const state = readState(harness.dir);
    expect(state.grant?.remainingSats).toBe(50_000_000n);
    expect(state.grant?.currency).toBe("VRSCTEST");
    expect(state.grant?.expiresAt).toBe(new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
    cmdGrant(["--revoke"], harness.ctx);
    expect(readState(harness.dir).grant).toBeNull();
  });

  it("arms and disarms the window", async () => {
    const harness = await initialized();
    cmdArm(["30"], harness.ctx);
    expect(readState(harness.dir).armedUntil).toBe(
      new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    );
    cmdDisarm([], harness.ctx);
    expect(readState(harness.dir).armedUntil).toBeNull();
  });
});

describe("status / history", () => {
  it("summarizes policy, caps and flags ambiguous requests", async () => {
    const harness = await initialized();
    const ledger = SpendLedger.open(harness.dir, { clock: () => NOW });
    ledger.recordPending(send({ requestId: "req-cli-ambig" }), "human-confirmed", "hash");
    ledger.recordAmbiguous("req-cli-ambig", "broadcast-transport-error");
    ledger.close();

    const code = cmdStatus([], harness.ctx);
    expect(code).toBe(0);
    const text = harness.out.join("\n");
    expect(text).toContain("1 ambiguous");
    expect(text).toContain("req-cli-ambig");
    expect(text).toContain("VRSCTEST");
  });

  it("history lists money requests and audit lines", async () => {
    const harness = await initialized();
    const ledger = SpendLedger.open(harness.dir, { clock: () => NOW });
    ledger.recordPending(send({ requestId: "req-cli-hist1" }), "auto", "hash");
    ledger.recordFailed("req-cli-hist1", "build", { message: "nope" });
    ledger.close();
    const code = cmdHistory(["--limit", "5"], harness.ctx);
    expect(code).toBe(0);
    const text = harness.out.join("\n");
    expect(text).toContain("req-cli-hist1".slice(0, 8) === "req-cli-" ? "send" : "send");
    expect(text).toContain("[failed]");
  });

  it("report aggregates spent amounts and lists recent requests", async () => {
    const harness = await initialized();
    const ledger = SpendLedger.open(harness.dir, { clock: () => NOW });
    ledger.recordPending(send({ requestId: "req-cli-rep1", amountSats: 25_000_000n }), "auto", "h");
    ledger.recordBroadcast("req-cli-rep1", "ab".repeat(32), [`${"cd".repeat(32)}:0`], null);
    ledger.recordPending(send({ requestId: "req-cli-rep2", amountSats: 10_000_000n }), "auto", "h");
    ledger.recordFailed("req-cli-rep2", "build", { message: "nope" });
    ledger.close();
    const code = cmdReport([], harness.ctx);
    expect(code).toBe(0);
    const text = harness.out.join("\n");
    expect(text).toContain("total counted as spent: 0.25000000");
    expect(text).toContain("req-cli-rep1");
    expect(text).toContain("1 failed");
  });
});

describe("doctor", () => {
  function respondHealthyNode(harness: Harness, address: string): void {
    harness.transport.respondJson(
      "getinfo",
      JSON.stringify({
        version: 2001100,
        VRSCversion: "1.2.17",
        blocks: 1_144_000,
        testnet: true,
        name: "VRSCTEST",
      }),
    );
    harness.transport.respondJson(
      "getaddressbalance",
      JSON.stringify({ balance: 100_000_000, received: 100_000_000 }),
    );
    harness.transport.respondJson(
      "getaddressutxos",
      JSON.stringify([
        { address, txid: "ab".repeat(32), outputIndex: 0, script: "76a9", satoshis: 100_000_000, height: 1 },
      ]),
    );
  }

  it("passes on a healthy wallet + node", async () => {
    const harness = await initialized();
    respondHealthyNode(harness, harness.address);
    const failures = await cmdDoctor([], harness.ctx);
    expect(failures).toBe(0);
    expect(harness.out.join("\n")).toContain("all checks passed");
  });

  it("fails on a missing policy", async () => {
    const harness = await initialized();
    fs.rmSync(path.join(harness.dir, "policy.json"));
    respondHealthyNode(harness, harness.address);
    const failures = await cmdDoctor([], harness.ctx);
    expect(failures).toBeGreaterThan(0);
    expect(harness.out.join("\n")).toContain("FAIL  policy.json");
  });

  it("fails when the keystore does not unlock with the configured passphrase", async () => {
    const harness = await initialized();
    harness.ctx.env["PECULIUM_KEYSTORE_PASSPHRASE"] = "wrong-passphrase";
    respondHealthyNode(harness, harness.address);
    const failures = await cmdDoctor([], harness.ctx);
    expect(failures).toBeGreaterThan(0);
    expect(harness.out.join("\n")).toContain("does NOT unlock");
  });

  it("fails when the node is unreachable", async () => {
    const harness = await initialized();
    harness.transport.failTransport("getinfo", "network");
    const failures = await cmdDoctor([], harness.ctx);
    expect(failures).toBeGreaterThan(0);
    expect(harness.out.join("\n")).toContain("FAIL  node");
  });

  it("flags ambiguous ledger rows as failures", async () => {
    const harness = await initialized();
    const ledger = SpendLedger.open(harness.dir, { clock: () => NOW });
    ledger.recordPending(send({ requestId: "req-cli-amb2" }), "auto", "hash");
    ledger.recordAmbiguous("req-cli-amb2", "broadcast-transport-error");
    ledger.close();
    respondHealthyNode(harness, harness.address);
    const failures = await cmdDoctor([], harness.ctx);
    expect(failures).toBeGreaterThan(0);
    expect(harness.out.join("\n")).toContain("ambiguous");
  });

  // Identity mode (E9): keystore R-address != i-address agentAddress is BY
  // DESIGN — doctor must verify control on-chain instead of failing locally.
  const ID_ADDRESS = "i5Ej7Bec8AYqxBbFEEd3UCKKhhpqAAm1rh";

  function switchToIdentityMode(harness: Harness): void {
    const policyPath = path.join(harness.dir, "policy.json");
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as Record<string, unknown>;
    policy["agentAddress"] = ID_ADDRESS;
    policy["addressMode"] = "verusid";
    fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  }

  it("identity mode: verifies control on-chain instead of flagging the address split", async () => {
    const harness = await initialized();
    switchToIdentityMode(harness);
    respondHealthyNode(harness, ID_ADDRESS);
    harness.transport.respondJson(
      "getidentity",
      JSON.stringify({
        status: "active",
        identity: { primaryaddresses: [harness.address], minimumsignatures: 1 },
      }),
    );
    const failures = await cmdDoctor([], harness.ctx);
    expect(failures).toBe(0);
    expect(harness.out.join("\n")).toContain("identity control verified on-chain");
  });

  it("identity mode: FAILS when the keystore key is no longer a primary address", async () => {
    const harness = await initialized();
    switchToIdentityMode(harness);
    respondHealthyNode(harness, ID_ADDRESS);
    harness.transport.respondJson(
      "getidentity",
      JSON.stringify({
        status: "active",
        identity: { primaryaddresses: ["RSomeOtherRotatedPrimaryAddress111"], minimumsignatures: 1 },
      }),
    );
    const failures = await cmdDoctor([], harness.ctx);
    expect(failures).toBeGreaterThan(0);
    expect(harness.out.join("\n")).toContain("NOT a primary address");
  });
});

describe("resolve", () => {
  it("settles an ambiguous request as not-spent (reservation released)", async () => {
    const harness = await initialized();
    const ledger = SpendLedger.open(harness.dir, { clock: () => NOW });
    ledger.recordPending(send({ requestId: "req-cli-res1" }), "auto", "hash");
    ledger.recordAmbiguous("req-cli-res1", "broadcast-transport-error");
    ledger.close();

    const code = await cmdResolve(["req-cli-res1", "--not-spent"], harness.ctx);
    expect(code).toBe(0);
    const snapshot = readLedgerSnapshot(harness.dir);
    const row = snapshot.rows.find((r) => r.requestId === "req-cli-res1");
    expect(row?.state).toBe("resolved");
    expect(row?.countsAsSpent).toBe(false);
  });

  it("repairs a torn ledger tail with --yes (backup kept)", async () => {
    const harness = await initialized();
    const ledger = SpendLedger.open(harness.dir, { clock: () => NOW });
    ledger.recordPending(send({ requestId: "req-cli-torn1" }), "auto", "hash");
    ledger.close();
    const ledgerPath = path.join(harness.dir, "ledger.jsonl");
    fs.appendFileSync(ledgerPath, '{"v":1,"type":"broad'); // torn append

    const code = await cmdResolve(["--repair-tail", "--yes"], harness.ctx);
    expect(code).toBe(0);
    expect(fs.readFileSync(ledgerPath, "utf8").endsWith("\n")).toBe(true);
    const backups = fs.readdirSync(harness.dir).filter((f) => f.includes("pre-repair"));
    expect(backups).toHaveLength(1);
    // The surviving ledger opens cleanly (request replays as ambiguous).
    const reopened = SpendLedger.open(harness.dir, { clock: () => NOW });
    expect(reopened.recoveredRequestIds).toContain("req-cli-torn1");
    reopened.close();
  });
});

describe("export-key", () => {
  it("prints the WIF only after the address ritual", async () => {
    const harness = await initialized();
    harness.ctx.env["PECULIUM_KEYSTORE_PASSPHRASE"] = PASSPHRASE;
    harness.out.length = 0; // drop init output; stdout must be ONLY the WIF
    const withPrompt = { ...harness.ctx, promptVisible: () => Promise.resolve(harness.address) };
    const code = await cmdExportKey([], withPrompt);
    expect(code).toBe(0);
    expect(harness.out).toHaveLength(1); // exactly the WIF, nothing else on stdout
    expect(harness.out[0]).toMatch(/^U/);
  });

  it("refuses on a wrong address", async () => {
    const harness = await initialized();
    harness.out.length = 0;
    const withPrompt = { ...harness.ctx, promptVisible: () => Promise.resolve("RWrong") };
    const code = await cmdExportKey([], withPrompt);
    expect(code).toBe(1);
    expect(harness.out).toHaveLength(0);
  });
});

describe("backup / restore", () => {
  it("round-trips the wallet into a fresh directory", async () => {
    const harness = await initialized();
    const archive = path.join(harness.dir, "wallet.pcbk");
    const backupCtx = {
      ...harness.ctx,
      promptHidden: () => Promise.resolve("backup-passphrase"),
    };
    expect(await cmdBackup([archive], backupCtx)).toBe(0);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-restore-"));
    dirs.push(target);
    const restoreCtx = { ...backupCtx, dir: target };
    expect(await cmdRestore([archive], restoreCtx)).toBe(0);
    expect(readKeystoreFile(target).address).toBe(harness.address);
    expect(loadPolicy(target).policy.agentAddress).toBe(harness.address);

    // Restoring again refuses to overwrite.
    await expect(cmdRestore([archive], restoreCtx)).rejects.toThrow(/refusing to overwrite/);
  });

  it("rejects a wrong backup passphrase", async () => {
    const harness = await initialized();
    const archive = path.join(harness.dir, "wallet.pcbk");
    await cmdBackup([archive], { ...harness.ctx, promptHidden: () => Promise.resolve("right-passphrase") });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-restore-"));
    dirs.push(target);
    await expect(
      cmdRestore([archive], {
        ...harness.ctx,
        dir: target,
        promptHidden: () => Promise.resolve("wrong-passphrase"),
      }),
    ).rejects.toThrow(/wrong passphrase or corrupted/);
  });
});

describe("runCli dispatch", () => {
  it("maps unknown commands to exit 2 with usage", async () => {
    const { ctx } = makeHarness();
    const code = await runCli(["definitely-not-a-command"], () => ctx);
    expect(code).toBe(2);
  });

  it("maps usage errors to exit 2 and domain errors to exit 1", async () => {
    const harness = makeHarness();
    expect(await runCli(["grant"], () => harness.ctx)).toBe(2); // missing amount
    expect(await runCli(["status"], () => harness.ctx)).toBe(1); // no policy yet
  });
});
