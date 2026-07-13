// LiteBackend units: verus-rpc MockTransport + the SDK's published test key.
// The E3 gate criteria: auto path signs+broadcasts once, definite failures
// reject (reservation released), transport failure after send ⇒ uncertain,
// and nothing is ever broadcast when the build path fails.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { utils as sdkUtils } from "@chainvue/verus-typescript-sdk";
import { MockTransport, VerusClient } from "verus-rpc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpendRejectedError, SpendUncertainError, type SpendInstruction } from "../src/backend.js";
import { createKeystoreFile, writeKeystoreFile } from "../src/keystore.js";
import { LiteBackend } from "../src/lite-backend.js";

// The SDK's committed fixture keypair (test-only, never funded on purpose).
const TEST_WIF = "UusoQWsobQKUkezgBJa22D9G4t9Avo6k8wD5UUxmmfAEoTN8bawc";
const TEST_ADDRESS = "RQr2cUkF46n7y8WRzDkd1iV9gHusSSQuzX";
const TEST_ADDRESS_B = "RPsQDnaxXgrLjcVBh3SpvCpTabWxAdMdzu";
const PASSPHRASE = "unit-test-passphrase";
const SCRIPT = sdkUtils.addressToScriptPubKey(TEST_ADDRESS).toString("hex");
const BROADCAST_TXID = "cd".repeat(32);

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function makeBackend(opts: { passphrase?: string | undefined; keystoreAddress?: string } = {}): {
  backend: LiteBackend;
  transport: MockTransport;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-lite-"));
  dirs.push(dir);
  writeKeystoreFile(
    dir,
    createKeystoreFile({
      wif: TEST_WIF,
      passphrase: PASSPHRASE,
      address: opts.keystoreAddress ?? TEST_ADDRESS,
      addressMode: "verusid",
    }),
  );
  const transport = new MockTransport();
  const client = new VerusClient({ transport });
  const backend = new LiteBackend({
    client,
    dir,
    chain: "VRSCTEST",
    passphrase: () => ("passphrase" in opts ? opts.passphrase : PASSPHRASE),
  });
  return { backend, transport };
}

function instruction(overrides: Partial<SpendInstruction> = {}): SpendInstruction {
  return {
    fromAddress: TEST_ADDRESS,
    toAddress: TEST_ADDRESS_B,
    amountSats: 100_000_000n,
    currency: "VRSCTEST",
    excludeOutpoints: [],
    spendableUnconfirmedChange: [],
    ...overrides,
  };
}

function utxoJson(txidByte: string, satoshis: number, vout = 0): string {
  return JSON.stringify({
    address: TEST_ADDRESS,
    txid: txidByte.repeat(32),
    outputIndex: vout,
    script: SCRIPT,
    satoshis,
    height: 100,
  });
}

function respondUtxos(transport: MockTransport, entries: string[]): void {
  transport.respondJson("getaddressutxos", `[${entries.join(",")}]`);
}

function broadcastCalls(transport: MockTransport): { method: string; params: unknown[] }[] {
  return transport.calls.filter((call) => call.method === "sendrawtransaction");
}

describe("LiteBackend happy path", () => {
  it("signs offline, broadcasts once, and reports exact outpoints", async () => {
    const { backend, transport } = makeBackend();
    respondUtxos(transport, [utxoJson("aa", 60_000_000), utxoJson("bb", 70_000_000)]);
    transport.respondJson("sendrawtransaction", `"${BROADCAST_TXID}"`);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const receipt = await backend.executeSpend(instruction());

    expect(receipt.txid).toBe(BROADCAST_TXID);
    const sends = broadcastCalls(transport);
    expect(sends).toHaveLength(1);

    // The receipt's outpoints must match the ACTUAL broadcast bytes.
    const hex = sends[0]?.params[0] as string;
    const summary = sdkUtils.summarizeSignedTransaction(hex, "testnet");
    expect(receipt.spentOutpoints.sort()).toEqual(
      summary.inputs.map((i) => `${i.txid}:${i.vout}`).sort(),
    );
    expect(receipt.spentOutpoints).toContain(`${"aa".repeat(32)}:0`);
    expect(receipt.spentOutpoints).toContain(`${"bb".repeat(32)}:0`);

    // Change output: last output back to our own address.
    let changeIndex = -1;
    for (let i = summary.outputs.length - 1; i >= 0; i -= 1) {
      if (summary.outputs[i]?.address === TEST_ADDRESS) {
        changeIndex = i;
        break;
      }
    }
    expect(receipt.changeOutpoint).toBe(`${BROADCAST_TXID}:${changeIndex}`);
    // Recipient got the exact amount.
    const paid = summary.outputs.find((o) => o.address === TEST_ADDRESS_B);
    expect(paid?.valueSat).toBe(100_000_000);
    warn.mockRestore();
  });

  it("excludes in-flight outpoints from selection", async () => {
    const { backend, transport } = makeBackend();
    respondUtxos(transport, [utxoJson("aa", 60_000_000), utxoJson("bb", 70_000_000)]);
    transport.respondJson("sendrawtransaction", `"${BROADCAST_TXID}"`);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const receipt = await backend.executeSpend(
      instruction({
        amountSats: 10_000_000n,
        excludeOutpoints: [`${"bb".repeat(32)}:0`],
      }),
    );

    expect(receipt.spentOutpoints).toContain(`${"aa".repeat(32)}:0`);
    expect(receipt.spentOutpoints).not.toContain(`${"bb".repeat(32)}:0`);
  });

  it("recovers clean unconfirmed own change from the mempool", async () => {
    const { backend, transport } = makeBackend();
    respondUtxos(transport, []); // nothing confirmed
    transport.respondJson(
      "getaddressmempool",
      JSON.stringify([
        // our pending change (positive delta at the wanted outpoint)
        { address: TEST_ADDRESS, txid: "ee".repeat(32), index: 1, satoshis: 50_000_000 },
        // an unrelated spend delta must be ignored
        { address: TEST_ADDRESS, txid: "ff".repeat(32), index: 0, satoshis: -10_000_000 },
      ]),
    );
    transport.respondJson("sendrawtransaction", `"${BROADCAST_TXID}"`);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const receipt = await backend.executeSpend(
      instruction({
        amountSats: 10_000_000n,
        spendableUnconfirmedChange: [`${"ee".repeat(32)}:1`],
      }),
    );

    expect(receipt.spentOutpoints).toEqual([`${"ee".repeat(32)}:1`]);
  });
});

describe("LiteBackend definite rejections (reservation released, zero broadcasts)", () => {
  it("rejects at build when funds are insufficient", async () => {
    const { backend, transport } = makeBackend();
    respondUtxos(transport, [utxoJson("aa", 1_000_000)]);

    await expect(backend.executeSpend(instruction())).rejects.toSatisfy(
      (e) => e instanceof SpendRejectedError && e.stage === "build",
    );
    expect(broadcastCalls(transport)).toHaveLength(0);
  });

  it("rejects at build when there are no spendable UTXOs", async () => {
    const { backend, transport } = makeBackend();
    respondUtxos(transport, [utxoJson("aa", 60_000_000)]);

    await expect(
      backend.executeSpend(instruction({ excludeOutpoints: [`${"aa".repeat(32)}:0`] })),
    ).rejects.toSatisfy((e) => e instanceof SpendRejectedError && e.stage === "build");
    expect(broadcastCalls(transport)).toHaveLength(0);
  });

  it("rejects at build when the UTXO fetch fails (nothing was sent)", async () => {
    const { backend, transport } = makeBackend();
    transport.failTransport("getaddressutxos", "network");

    await expect(backend.executeSpend(instruction())).rejects.toSatisfy(
      (e) => e instanceof SpendRejectedError && e.stage === "build",
    );
    expect(broadcastCalls(transport)).toHaveLength(0);
  });

  it("rejects with zero RPC calls when the passphrase is missing", async () => {
    const { backend, transport } = makeBackend({ passphrase: undefined });

    await expect(backend.executeSpend(instruction())).rejects.toSatisfy(
      (e) => e instanceof SpendRejectedError && e.stage === "build",
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects with zero RPC calls on keystore/policy address drift", async () => {
    const { backend, transport } = makeBackend({ keystoreAddress: TEST_ADDRESS_B });

    await expect(backend.executeSpend(instruction())).rejects.toSatisfy(
      (e) =>
        e instanceof SpendRejectedError &&
        e.stage === "build" &&
        e.message.includes("drift"),
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects at build on a wrong passphrase (unlock fails locally)", async () => {
    const { backend, transport } = makeBackend({ passphrase: "wrong-passphrase" });
    respondUtxos(transport, [utxoJson("aa", 200_000_000)]);

    await expect(backend.executeSpend(instruction())).rejects.toSatisfy(
      (e) => e instanceof SpendRejectedError && e.stage === "build",
    );
    expect(broadcastCalls(transport)).toHaveLength(0);
  });

  it("rejects at build when a non-native currency cannot be resolved", async () => {
    const { backend, transport } = makeBackend();
    transport.respondError("getcurrency", -5, "currency not found");

    await expect(backend.executeSpend(instruction({ currency: "NOPE" }))).rejects.toSatisfy(
      (e) =>
        e instanceof SpendRejectedError && e.stage === "build" && e.message.includes("NOPE"),
    );
    expect(broadcastCalls(transport)).toHaveLength(0);
  });

  it("maps a daemon broadcast rejection to broadcast-rejected with the rpc code", async () => {
    const { backend, transport } = makeBackend();
    respondUtxos(transport, [utxoJson("aa", 200_000_000)]);
    transport.respondError("sendrawtransaction", -26, "tx-conflict");

    await expect(backend.executeSpend(instruction())).rejects.toSatisfy(
      (e) =>
        e instanceof SpendRejectedError &&
        e.stage === "broadcast-rejected" &&
        e.detail.code === -26,
    );
  });
});

describe("LiteBackend uncertainty (fail closed)", () => {
  it("maps a transport failure during broadcast to SpendUncertainError", async () => {
    const { backend, transport } = makeBackend();
    respondUtxos(transport, [utxoJson("aa", 200_000_000)]);
    transport.failTransport("sendrawtransaction", "timeout");

    await expect(backend.executeSpend(instruction())).rejects.toBeInstanceOf(
      SpendUncertainError,
    );
    // The broadcast WAS attempted — exactly once, never retried blindly.
    expect(broadcastCalls(transport)).toHaveLength(1);
  });
});
