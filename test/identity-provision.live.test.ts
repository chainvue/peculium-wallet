// E6 gated live proof: register a REAL throwaway VerusID FULLY daemon-free —
// commitment, registration and verification all through the public testnet
// node. The LAN daemon only funds the throwaway key (setup).
//
// (Historical note: this test once failed with "Transaction has absurd
// fees" — that was CLIENT-side, utxo-lib's fee-rate cap at build(), fixed in
// the SDK. The daemon itself exempts identity definitions from its
// absurd-fee check, so the 1-arg public-gateway broadcast works.)
//
// COST: burns ~100 tVRSC (protocol registration fee) plus dust. Gates:
// PECULIUM_LIVE_ID=1 + VERUS_RPC_URL/USER/PASS. Runtime ~3-6 min.

import { VerusSDK } from "@chainvue/verus-sdk";
import { VerusClient } from "@chainvue/verus-rpc";
import { describe, expect, it } from "vitest";

import { provisionIdentity } from "../src/identity-provision.js";

const PUBLIC_URL = process.env["PECULIUM_PUBLIC_NODE_URL"] ?? "https://api.verustest.net";
const LAN_URL = process.env["VERUS_RPC_URL"];
const LAN_USER = process.env["VERUS_RPC_USER"];
const LAN_PASS = process.env["VERUS_RPC_PASS"];
const enabled =
  process.env["PECULIUM_LIVE_ID"] === "1" &&
  LAN_URL !== undefined &&
  LAN_USER !== undefined &&
  LAN_PASS !== undefined;

// An existing identity on VRSCTEST serving as the cold authority for the
// throwaway (v402-agent@ — controlled by the same operator).
const COLD_AUTHORITY = "iRPkkTHYwRy3vsMvZvEXH6CGy2X1UEva2N";
const FUND_COINS = 101;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!enabled)("daemon-free identity registration (public node)", () => {
  it(
    "registers a throwaway VerusID end to end",
    async () => {
      const wif = VerusSDK.generateWif();
      const address = await VerusSDK.deriveAddress(wif);
      const name = `pecu-e6-${Date.now().toString(36)}`;

      // Fund the throwaway from the LAN wallet (setup only).
      const lan = new VerusClient({
        url: LAN_URL as string,
        user: LAN_USER as string,
        pass: LAN_PASS as string,
      });
      const fundingTxid = (await lan.call("sendtoaddress", [address, FUND_COINS])) as string;
      console.log(`[live-id] funded ${address} with ${FUND_COINS} (tx ${fundingTxid.slice(0, 12)}…)`);

      const publicClient = new VerusClient({ url: PUBLIC_URL });
      const deadline = Date.now() + 240_000;
      for (;;) {
        try {
          const raw = (await publicClient.call("getrawtransaction", [fundingTxid, 1])) as {
            confirmations?: number;
          };
          if ((raw.confirmations ?? 0) >= 1) {
            break;
          }
        } catch {
          // not indexed yet
        }
        if (Date.now() > deadline) {
          throw new Error("funding tx did not confirm in time");
        }
        await sleep(5_000);
      }

      // EVERYTHING through the public node: reads, commitment AND the
      // registration broadcast — the full daemon-free, offline-signed proof.
      const result = await provisionIdentity({
        client: publicClient,
        chain: "VRSCTEST",
        wif,
        address,
        name,
        revocationAuthority: COLD_AUTHORITY,
        recoveryAuthority: COLD_AUTHORITY,
        onStatus: (line) => console.log(`[live-id] ${line}`),
      });

      expect(result.identityName).toBe(`${name}@`);
      console.log(
        `[live-id] SUCCESS ${result.identityName} = ${result.identityAddress} ` +
          `(commitment ${result.commitmentTxid.slice(0, 12)}…, ` +
          `registration ${result.registrationTxid.slice(0, 12)}…)`,
      );

      // Authorities recorded correctly on-chain.
      const identity = (await publicClient.call("getidentity", [`${name}@`])) as {
        identity: { revocationauthority: string; recoveryauthority: string };
      };
      expect(identity.identity.revocationauthority).toBe(COLD_AUTHORITY);
      expect(identity.identity.recoveryauthority).toBe(COLD_AUTHORITY);
    },
    600_000,
  );
});
