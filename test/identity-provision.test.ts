// provisionIdentity units: the REAL SDK builds commitment + registration
// offline (fixture key); only the node is mocked. Verifies the orchestration
// order, the commitment-output handoff and the on-chain verification step.

import { utils as sdkUtils, VerusSDK } from "@chainvue/verus-typescript-sdk";
import { MockTransport, VerusClient } from "verus-rpc";
import { describe, expect, it } from "vitest";

import { IdentityProvisionError, provisionIdentity } from "../src/identity-provision.js";

const TEST_WIF = "UusoQWsobQKUkezgBJa22D9G4t9Avo6k8wD5UUxmmfAEoTN8bawc";
const TEST_ADDRESS = "RQr2cUkF46n7y8WRzDkd1iV9gHusSSQuzX";
const COLD_AUTHORITY = "iRPkkTHYwRy3vsMvZvEXH6CGy2X1UEva2N";
const VRSCTEST_SYSTEM_ID = "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq";
const SCRIPT = sdkUtils.addressToScriptPubKey(TEST_ADDRESS).toString("hex");

function fundingJson(txidByte: string, satoshis: number): string {
  return JSON.stringify([
    {
      address: TEST_ADDRESS,
      txid: txidByte.repeat(32),
      outputIndex: 0,
      script: SCRIPT,
      satoshis,
      height: 10,
    },
  ]);
}

describe("provisionIdentity", () => {
  it("runs commitment -> confirm -> registration -> confirm -> verify", async () => {
    const name = "pecu-unit";
    const expectedId = VerusSDK.deriveIdentityAddress(name, VRSCTEST_SYSTEM_ID);
    const transport = new MockTransport();
    // 1. commitment funding
    transport.respondJson("getaddressutxos", fundingJson("aa", 30_000_000_000));
    // 2. commitment broadcast (result unused — SDK txid is authoritative here)
    transport.respondJson("sendrawtransaction", '"accepted"');
    // 3. commitment confirmation poll
    transport.respondJson("getrawtransaction", '{"confirmations":1}');
    // 4. registration funding
    transport.respondJson("getaddressutxos", fundingJson("bb", 30_000_000_000));
    // 5. registration broadcast
    transport.respondJson("sendrawtransaction", '"accepted"');
    // 6. registration confirmation poll
    transport.respondJson("getrawtransaction", '{"confirmations":1}');
    // 7. on-chain verification
    transport.respondJson(
      "getidentity",
      JSON.stringify({ identity: { identityaddress: expectedId } }),
    );

    const statuses: string[] = [];
    const result = await provisionIdentity({
      client: new VerusClient({ transport }),
      chain: "VRSCTEST",
      wif: TEST_WIF,
      address: TEST_ADDRESS,
      name,
      revocationAuthority: COLD_AUTHORITY,
      recoveryAuthority: COLD_AUTHORITY,
      pollMs: 1,
      timeoutMs: 10_000,
      onStatus: (line) => statuses.push(line),
    });

    expect(result.identityAddress).toBe(expectedId);
    expect(result.identityName).toBe(`${name}@`);

    // The registration must SPEND the commitment output.
    const broadcasts = transport.calls.filter((c) => c.method === "sendrawtransaction");
    expect(broadcasts).toHaveLength(2);
    const registrationHex = broadcasts[1]?.params[0] as string;
    const summary = sdkUtils.summarizeSignedTransaction(registrationHex, "testnet");
    const outpoints = summary.inputs.map((i) => `${i.txid}:${i.vout}`);
    expect(outpoints.some((o) => o.startsWith(result.commitmentTxid))).toBe(true);
    expect(statuses.join("\n")).toContain("registered and verified");
  });

  it("refuses when the on-chain identity does not match the computed one", async () => {
    const transport = new MockTransport();
    transport.respondJson("getaddressutxos", fundingJson("aa", 30_000_000_000));
    transport.respondJson("sendrawtransaction", '"accepted"');
    transport.respondJson("getrawtransaction", '{"confirmations":1}');
    transport.respondJson("getaddressutxos", fundingJson("bb", 30_000_000_000));
    transport.respondJson("sendrawtransaction", '"accepted"');
    transport.respondJson("getrawtransaction", '{"confirmations":1}');
    transport.respondJson(
      "getidentity",
      JSON.stringify({ identity: { identityaddress: "iSomebodyElse111111111111111111111" } }),
    );

    await expect(
      provisionIdentity({
        client: new VerusClient({ transport }),
        chain: "VRSCTEST",
        wif: TEST_WIF,
        address: TEST_ADDRESS,
        name: "pecu-unit2",
        revocationAuthority: COLD_AUTHORITY,
        recoveryAuthority: COLD_AUTHORITY,
        pollMs: 1,
        timeoutMs: 10_000,
      }),
    ).rejects.toBeInstanceOf(IdentityProvisionError);
  });

  it("rejects implausible names and empty funding upfront", async () => {
    const transport = new MockTransport();
    const client = new VerusClient({ transport });
    const base = {
      client,
      chain: "VRSCTEST" as const,
      wif: TEST_WIF,
      address: TEST_ADDRESS,
      revocationAuthority: COLD_AUTHORITY,
      recoveryAuthority: COLD_AUTHORITY,
      pollMs: 1,
      timeoutMs: 1_000,
    };
    await expect(provisionIdentity({ ...base, name: "bad@name" })).rejects.toBeInstanceOf(
      IdentityProvisionError,
    );
    transport.respondJson("getaddressutxos", "[]");
    await expect(provisionIdentity({ ...base, name: "pecu-unit3" })).rejects.toThrow(
      /no spendable UTXOs/,
    );
    expect(transport.calls.filter((c) => c.method === "sendrawtransaction")).toHaveLength(0);
  });
});
