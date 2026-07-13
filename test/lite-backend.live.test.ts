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
