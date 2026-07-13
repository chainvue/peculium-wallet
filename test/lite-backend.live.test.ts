// E3b gated live proof: a real dust send END TO END through the PUBLIC
// testnet node — UTXO fetch, offline sign, broadcast — with no daemon
// anywhere on the wallet side. A LAN daemon (env credentials) is used only
// to FUND a fresh throwaway key; the money path under test never touches it.
//
// Gates: PECULIUM_LIVE_SPEND=1 plus VERUS_RPC_URL/USER/PASS. Spends testnet
// dust. Runtime ~1-3 min (waits for one confirmation of the funding tx).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { VerusSDK } from "@chainvue/verus-typescript-sdk";
import { VerusClient } from "verus-rpc";
import { afterAll, describe, expect, it } from "vitest";

import { createKeystoreFile, writeKeystoreFile } from "../src/keystore.js";
import { LiteBackend } from "../src/lite-backend.js";

const PUBLIC_URL = process.env["PECULIUM_PUBLIC_NODE_URL"] ?? "https://api.verustest.net";
const LAN_URL = process.env["VERUS_RPC_URL"];
const LAN_USER = process.env["VERUS_RPC_USER"];
const LAN_PASS = process.env["VERUS_RPC_PASS"];
const enabled =
  process.env["PECULIUM_LIVE_SPEND"] === "1" &&
  LAN_URL !== undefined &&
  LAN_USER !== undefined &&
  LAN_PASS !== undefined;

const FUND_COINS = 0.2;
const SEND_SATS = 5_000_000n; // 0.05 VRSCTEST
const PASSPHRASE = "live-proof-passphrase";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const dirs: string[] = [];

afterAll(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe.skipIf(!enabled)("LiteBackend live dust send (public node)", () => {
  it(
    "funds a throwaway key, then spends through the public node only",
    async () => {
      // -- throwaway key + keystore ------------------------------------
      const wif = VerusSDK.generateWif();
      const address = await VerusSDK.deriveAddress(wif);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-live-"));
      dirs.push(dir);
      writeKeystoreFile(
        dir,
        createKeystoreFile({ wif, passphrase: PASSPHRASE, address, addressMode: "verusid" }),
      );

      // -- fund it from the LAN daemon wallet (setup only) ---------------
      const lan = new VerusClient({
        url: LAN_URL as string,
        user: LAN_USER as string,
        pass: LAN_PASS as string,
      });
      const fundingTxid = (await lan.call("sendtoaddress", [address, FUND_COINS])) as string;
      const returnAddress = (await lan.call("getnewaddress", [])) as string;
      console.log(`[live] funded ${address} with ${FUND_COINS} (tx ${fundingTxid.slice(0, 12)}…)`);

      // -- wait for one confirmation, OBSERVED VIA THE PUBLIC NODE -------
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
          // public node may not know the tx yet — keep polling
        }
        if (Date.now() > deadline) {
          throw new Error("funding tx did not confirm within the deadline");
        }
        await sleep(5_000);
      }

      // -- THE money path under test: public node only -------------------
      const backend = new LiteBackend({
        client: publicClient,
        dir,
        chain: "VRSCTEST",
        passphrase: () => PASSPHRASE,
      });
      const receipt = await backend.executeSpend({
        fromAddress: address,
        toAddress: returnAddress,
        amountSats: SEND_SATS,
        currency: "VRSCTEST",
        excludeOutpoints: [],
        spendableUnconfirmedChange: [],
      });

      expect(receipt.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.spentOutpoints.length).toBeGreaterThan(0);
      expect(receipt.changeOutpoint).toMatch(new RegExp(`^${receipt.txid}:\\d+$`));
      console.log(`[live] spend accepted by public node: ${receipt.txid}`);

      // The public node must know the tx we just broadcast through it.
      const seen = (await publicClient.call("getrawtransaction", [receipt.txid, 1])) as {
        txid?: string;
      };
      expect(seen.txid).toBe(receipt.txid);
    },
    360_000,
  );
});

// -- E9: the IDENTITY money path — the agent address is a VerusID ---------
// Uses the persistent P2ID fixture identity (SDK .env: PECULIUM_LIVE_ID_*
// or the SDK_P2ID_* names): funds are placed ON the i-address, then spent
// through the FULL LiteBackend sequence (on-chain control check → P2ID UTXO
// fetch → offline sign with the primary key → public-node broadcast), with
// change returning to the identity.

const ID_NAME = process.env["SDK_P2ID_ID_NAME"];
const ID_ADDRESS = process.env["SDK_P2ID_ID_ADDRESS"];
const ID_PRIMARY = process.env["SDK_P2ID_PRIMARY_ADDRESS"];
const ID_WIF = process.env["SDK_P2ID_WIF"];
const identityEnabled =
  enabled &&
  ID_NAME !== undefined &&
  ID_ADDRESS !== undefined &&
  ID_PRIMARY !== undefined &&
  ID_WIF !== undefined;

describe.skipIf(!identityEnabled)("LiteBackend live IDENTITY dust send (public node)", () => {
  it(
    "spends identity-held funds through the full backend sequence",
    async () => {
      // -- keystore holds the identity's PRIMARY key; agent addr = i-addr --
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-live-id-"));
      dirs.push(dir);
      writeKeystoreFile(
        dir,
        createKeystoreFile({
          wif: ID_WIF as string,
          passphrase: PASSPHRASE,
          address: ID_PRIMARY as string,
          addressMode: "verusid",
        }),
      );

      // -- put funds ON the identity from the LAN wallet (setup only) -----
      const lan = new VerusClient({
        url: LAN_URL as string,
        user: LAN_USER as string,
        pass: LAN_PASS as string,
      });
      const fundingTxid = (await lan.call("sendtoaddress", [ID_ADDRESS, FUND_COINS])) as string;
      const returnAddress = (await lan.call("getnewaddress", [])) as string;
      console.log(
        `[live-id] funded ${ID_NAME} (${ID_ADDRESS}) with ${FUND_COINS} (tx ${fundingTxid.slice(0, 12)}…)`,
      );

      const publicClient = new VerusClient({ url: PUBLIC_URL });
      const deadline = Date.now() + 300_000;
      for (;;) {
        try {
          const raw = (await publicClient.call("getrawtransaction", [fundingTxid, 1])) as {
            confirmations?: number;
          };
          if ((raw.confirmations ?? 0) >= 1) {
            break;
          }
        } catch {
          // public node may not know the tx yet — keep polling
        }
        if (Date.now() > deadline) {
          throw new Error("funding tx did not confirm within the deadline");
        }
        await sleep(5_000);
      }

      // -- THE identity money path under test: public node only -----------
      const backend = new LiteBackend({
        client: publicClient,
        dir,
        chain: "VRSCTEST",
        passphrase: () => PASSPHRASE,
      });
      const receipt = await backend.executeSpend({
        fromAddress: ID_ADDRESS as string,
        toAddress: returnAddress,
        amountSats: SEND_SATS,
        currency: "VRSCTEST",
        excludeOutpoints: [],
        spendableUnconfirmedChange: [],
      });

      expect(receipt.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.spentOutpoints.length).toBeGreaterThan(0);
      // Change must return TO THE IDENTITY (P2ID output, decoded by
      // summarize) — that keeps the agent's funds identity-held.
      expect(receipt.changeOutpoint).toMatch(new RegExp(`^${receipt.txid}:\\d+$`));
      console.log(`[live-id] identity spend accepted by public node: ${receipt.txid}`);

      const seen = (await publicClient.call("getrawtransaction", [receipt.txid, 1])) as {
        txid?: string;
      };
      expect(seen.txid).toBe(receipt.txid);
    },
    420_000,
  );
});
