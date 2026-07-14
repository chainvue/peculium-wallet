// Gated live ring for wallet_paid_fetch: the REAL payment path against a
// REAL v402 facilitator and a REAL guarded endpoint — preflight, price
// gate, identity signature from the keystore, payment header on the wire,
// facilitator debit of the prepaid balance.
//
// Setup (see docs/PLAN-wallet-paid-fetch.md): run the local facilitator
// (~/Developer/v402 packages/facilitator, V402_WATCHER_MODE=real) plus a
// guarded demo endpoint, and fund the fixture identity's PREPAID balance
// there (wallet_topup_facilitator or a direct on-chain topup).
//
// Gates: PECULIUM_LIVE_PAIDFETCH=1 plus
//   V402_LIVE_SERVICE_URL      — a priced endpoint, e.g. http://127.0.0.1:3300/api/premium
//   V402_LIVE_FACILITATOR_URL  — the facilitator apiUrl, e.g. http://127.0.0.1:3200
//   SDK_P2ID_ID_ADDRESS / SDK_P2ID_PRIMARY_ADDRESS / SDK_P2ID_WIF — the
//   funded fixture identity (WIF lives in ~/Developer/verus-sdk/.env).
// Optional: V402_LIVE_MAX_PER_CALL (default "0.01"), V402_LIVE_MAX_PER_DAY
// (default "0.05"), PECULIUM_PUBLIC_NODE_URL.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { V402Client } from "@chainvue/v402-client-fetch";
import { LocalKeySigner } from "@chainvue/v402-signer-verus";
import { NETWORK_CONFIG } from "@chainvue/verus-sdk";
import { parseAmount, VerusClient } from "@chainvue/verus-rpc";
import { afterAll, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit.js";
import { StaticConfirmer } from "../src/confirm.js";
import { createKeystoreFile, writeKeystoreFile } from "../src/keystore.js";
import { SpendLedger } from "../src/ledger/ledger.js";
import { PaymentGate } from "../src/payment-gate.js";
import { V402PaymentBackend } from "../src/payment.js";
import { PolicySource } from "../src/policy/load.js";
import { PublicNodeReader } from "../src/reader.js";

const PUBLIC_URL = process.env["PECULIUM_PUBLIC_NODE_URL"] ?? "https://api.verustest.net";
const SERVICE_URL = process.env["V402_LIVE_SERVICE_URL"];
const FACILITATOR_URL = process.env["V402_LIVE_FACILITATOR_URL"];
const ID_ADDRESS = process.env["SDK_P2ID_ID_ADDRESS"];
const ID_PRIMARY = process.env["SDK_P2ID_PRIMARY_ADDRESS"];
const ID_WIF = process.env["SDK_P2ID_WIF"];
const MAX_PER_CALL = process.env["V402_LIVE_MAX_PER_CALL"] ?? "0.01";
const MAX_PER_DAY = process.env["V402_LIVE_MAX_PER_DAY"] ?? "0.05";

const enabled =
  process.env["PECULIUM_LIVE_PAIDFETCH"] === "1" &&
  SERVICE_URL !== undefined &&
  FACILITATOR_URL !== undefined &&
  ID_ADDRESS !== undefined &&
  ID_PRIMARY !== undefined &&
  ID_WIF !== undefined;

const PASSPHRASE = "live-paidfetch-passphrase";

const dirs: string[] = [];

afterAll(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe.skipIf(!enabled)("wallet_paid_fetch live ring (real facilitator)", () => {
  it(
    "pays a real 402 offer and the facilitator debits the prepaid balance",
    async () => {
      const serviceUrl = new URL(SERVICE_URL as string);

      // -- wallet dir: keystore (identity primary key) + policy ----------
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-live-pf-"));
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
      fs.writeFileSync(
        path.join(dir, "policy.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            network: "VRSCTEST",
            agentAddress: ID_ADDRESS,
            addressMode: "verusid",
            currencies: [
              { currency: "VRSCTEST", maxPerTx: "2", maxPerDay: "8", maxTotal: "20" },
            ],
            facilitators: [
              {
                name: "live-facilitator",
                address: "RFacilitatorPlaceholder11111111111",
                currency: "VRSCTEST",
                maxPerTx: "0.5",
                maxPerDay: "2",
                autoApprove: true,
                apiUrl: FACILITATOR_URL,
              },
            ],
            recipients: [],
            services: [
              {
                name: "live-api",
                origin: serviceUrl.origin,
                facilitator: "live-facilitator",
                currency: "VRSCTEST",
                maxPricePerCall: MAX_PER_CALL,
                maxPerDay: MAX_PER_DAY,
                autoApprove: true,
              },
            ],
            rate: { maxSendsPerHour: 10, minSecondsBetweenSends: 0, dedupeWindowSeconds: 600 },
            armRequired: false,
            confirmTimeoutSeconds: 120,
            createdAt: "2026-07-14T00:00:00Z",
            updatedAt: "2026-07-14T00:00:00Z",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );

      // The production backend reads the passphrase from the env at PAY time.
      process.env["PECULIUM_KEYSTORE_PASSPHRASE"] = PASSPHRASE;

      const reader = new PublicNodeReader(new VerusClient({ url: PUBLIC_URL }), "VRSCTEST");
      const payer = await reader.getFriendlyName(ID_ADDRESS as string);
      if (payer === null) {
        throw new Error(`fixture identity ${ID_ADDRESS} not resolvable via ${PUBLIC_URL}`);
      }

      // -- prepaid balance BEFORE (signed query, same identity) -----------
      const signer = new LocalKeySigner(ID_WIF as string, {
        identity: {
          identityAddress: ID_ADDRESS as string,
          systemId: NETWORK_CONFIG.testnet.chainId,
        },
        heightProvider: async () => {
          const height = await reader.getBlockHeight();
          if (height === null) {
            throw new Error("chain height unavailable");
          }
          return height;
        },
      });
      const facilitatorClient = new V402Client({
        identity: payer,
        signer,
        facilitator: FACILITATOR_URL as string,
      });
      const before = await facilitatorClient.getBalance();
      console.log(`[live-pf] prepaid before: ${before.available} available (${payer})`);

      // -- THE path under test: the full PaymentGate over the real wire ---
      const ledger = SpendLedger.open(dir);
      const audit = AuditLog.open(dir);
      const gate = new PaymentGate({
        policySource: new PolicySource(dir),
        ledger,
        backend: new V402PaymentBackend({ reader, stateDir: dir }),
        confirmer: new StaticConfirmer("approved"),
        audit,
        stateDir: dir,
      });
      const requestId = `live-pf-${Date.now().toString(36)}`;
      const outcome = await gate.execute({
        requestId,
        service: "live-api",
        path: `${serviceUrl.pathname}${serviceUrl.search}`,
        method: "GET",
      });
      audit.close();
      ledger.close();

      console.log(`[live-pf] outcome: ${JSON.stringify({ ...outcome, response: undefined })}`);
      expect(outcome.status).toBe("settled");
      if (outcome.status !== "settled") {
        return;
      }
      expect(outcome.response.httpStatus).toBe(200);
      expect(outcome.amountSats).toBeGreaterThan(0n);
      console.log(
        `[live-pf] paid ${outcome.amountSats} sats for ${outcome.response.body.slice(0, 80)}…`,
      );

      // -- the facilitator's ledger must show the REAL debit --------------
      const after = await facilitatorClient.getBalance();
      const debited = parseAmount(before.available) - parseAmount(after.available);
      console.log(`[live-pf] prepaid after: ${after.available} (debited ${debited} sats)`);
      expect(debited).toBe(outcome.amountSats);
    },
    120_000,
  );
});
