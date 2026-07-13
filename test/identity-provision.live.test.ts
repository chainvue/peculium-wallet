// E6 gated live test: attempt to register a REAL throwaway VerusID —
// commitment, registration, verification.
//
// ⚠️ CURRENTLY REPRODUCES A KNOWN BLOCKER (RISKS.md → Etappe 6): the
// commitment step succeeds daemon-free, but the registration broadcast is
// rejected with "Transaction has absurd fees" — an identity-registration
// specific guard in Verus's sendrawtransaction that allowhighfees does not
// lift, on ANY node (proven by contrast with a plain 100-coin-fee tx, which
// IS accepted with the flag). This test therefore FAILS at the registration
// step by design until the broadcast path is unblocked. It stays gated so it
// never runs in CI; run it to re-verify the blocker or confirm a fix.
//
// COST when run: the commitment dust; the registration never lands, so the
// ~100 tVRSC protocol fee is NOT burned. Gates: PECULIUM_LIVE_ID=1 +
// VERUS_RPC_URL/USER/PASS. Runtime ~3-6 min.

import { VerusSDK } from "@chainvue/verus-typescript-sdk";
import { VerusClient } from "verus-rpc";
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

      // Reads + commitment via the PUBLIC node (daemon-free); the
      // registration tx pays the protocol fee as a high fee and needs
      // allowhighfees, which the public gateway rejects — so it broadcasts
      // through the LAN node. Everything is still OFFLINE-signed.
      const result = await provisionIdentity({
        client: publicClient,
        registrationClient: lan,
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
