/**
 * Daemon-free VerusID provisioning (E6): the SDK's offline
 * commitment→registration flow, broadcast through a public node.
 *
 *   1. build + sign the name commitment offline, broadcast, wait 1 conf
 *   2. build + sign the registration (spending the commitment output),
 *      broadcast, wait 1 conf
 *   3. verify with `getidentity name@` on the node
 *
 * Root registration on VRSCTEST burns the protocol fee (100 tVRSC without
 * a referral, 80 with one) from the funding address — the caller confirms
 * that BEFORE this module runs. Revocation/recovery authorities should be
 * COLD identities (see docs/IDENTITY-RUNBOOK.md); defaulting them to the
 * identity itself would make revocation meaningless.
 */

import { VerusSDK, utils as sdkUtils } from "@chainvue/verus-typescript-sdk";
import type { VerusClient } from "verus-rpc";

import { PeculiumError } from "./errors.js";
import type { SupportedChain } from "./limits.js";

export class IdentityProvisionError extends PeculiumError {
  constructor(message: string) {
    super("identity-provision", message);
    this.name = "IdentityProvisionError";
  }
}

export interface ProvisionIdentityParams {
  /** Reads + commitment broadcast (a public gateway is fine here). */
  client: VerusClient;
  /**
   * Broadcast client for the REGISTRATION tx. The registration pays the
   * protocol fee as an implicit miner fee (~100 native), and Verus's
   * `sendrawtransaction` applies an identity-registration-specific
   * absurd-fee guard that `allowhighfees` does NOT lift — even on a node you
   * control. See RISKS.md → Etappe 6: this broadcast is a KNOWN BLOCKER.
   * The commitment (step 1) and all reads are daemon-free and work; the
   * registration broadcast below currently fails with "Transaction has
   * absurd fees" regardless of which node it targets. This param is kept so
   * the flow is ready the moment the broadcast path is unblocked (e.g. a
   * daemon `registeridentity`-style submission that bypasses the guard).
   * Defaults to `client`.
   */
  registrationClient?: VerusClient;
  chain: SupportedChain;
  /** The funding key — must hold the registration fee + tx fees. */
  wif: string;
  /** The funding R-address (also becomes the identity's primary address). */
  address: string;
  /** Identity name WITHOUT the "@" (e.g. "my-agent"). */
  name: string;
  /** COLD revocation authority (i-address or identity name). */
  revocationAuthority: string;
  /** COLD recovery authority (i-address or identity name). */
  recoveryAuthority: string;
  /** Optional referral identity (reduces the burn from 100 to 80). */
  referral?: string;
  /** Progress callback (CLI prints these). */
  onStatus?: (line: string) => void;
  /** Poll interval / deadline (tests shrink these). */
  pollMs?: number;
  timeoutMs?: number;
}

export interface ProvisionIdentityResult {
  identityAddress: string;
  identityName: string;
  commitmentTxid: string;
  registrationTxid: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmation(
  client: VerusClient,
  txid: string,
  what: string,
  pollMs: number,
  deadline: number,
  onStatus: (line: string) => void,
): Promise<void> {
  onStatus(`waiting for ${what} ${txid.slice(0, 12)}… to confirm`);
  for (;;) {
    try {
      const raw = (await client.call("getrawtransaction", [txid, 1])) as {
        confirmations?: number;
      };
      if ((raw.confirmations ?? 0) >= 1) {
        onStatus(`${what} confirmed`);
        return;
      }
    } catch {
      // The node may not have indexed the tx yet — keep polling.
    }
    if (Date.now() > deadline) {
      throw new IdentityProvisionError(
        `${what} ${txid} did not confirm within the deadline; check the node and retry ` +
          `(the broadcast itself succeeded — do NOT resubmit the same commitment).`,
      );
    }
    await sleep(pollMs);
  }
}

/** Fetch spendable plain-value UTXOs for the funding address. */
async function fetchFundingUtxos(
  client: VerusClient,
  address: string,
): Promise<{ txid: string; outputIndex: number; satoshis: number; script: string; height: number }[]> {
  const confirmed = await client.addressIndex.getAddressUtxos({ addresses: [address] });
  return confirmed
    .filter((utxo) => utxo.satoshis > 0n)
    .map((utxo) => ({
      txid: utxo.txid,
      outputIndex: utxo.outputIndex,
      satoshis: Number(utxo.satoshis),
      script: utxo.script,
      height: utxo.height ?? 0,
    }));
}

/** Run the full daemon-free provisioning flow. See the module doc. */
export async function provisionIdentity(
  params: ProvisionIdentityParams,
): Promise<ProvisionIdentityResult> {
  const onStatus = params.onStatus ?? ((): void => undefined);
  const pollMs = params.pollMs ?? 5_000;
  const timeoutMs = params.timeoutMs ?? 300_000;
  const network = params.chain === "VRSCTEST" ? ("testnet" as const) : ("mainnet" as const);
  const sdk = new VerusSDK({ network });

  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(params.name) || params.name.includes("@")) {
    throw new IdentityProvisionError(
      `"${params.name}" is not a plausible identity name (no @, alphanumeric + dashes)`,
    );
  }

  // -- 1. commitment ---------------------------------------------------
  const utxos = await fetchFundingUtxos(params.client, params.address);
  if (utxos.length === 0) {
    throw new IdentityProvisionError(
      `${params.address} has no spendable UTXOs — fund it first (registration burns ` +
        `the protocol fee plus tx fees).`,
    );
  }
  const commitment = sdk.createCommitment({
    wif: params.wif,
    name: params.name,
    utxos,
    changeAddress: params.address,
    ...(params.referral !== undefined ? { referral: params.referral } : {}),
  });
  onStatus(`commitment built (identity will be ${commitment.identityAddress})`);
  await params.client.call("sendrawtransaction", [commitment.signedTx]);
  const deadline = Date.now() + timeoutMs;
  await waitForConfirmation(
    params.client,
    commitment.txid,
    "name commitment",
    pollMs,
    deadline,
    onStatus,
  );

  // -- 2. registration ---------------------------------------------------
  // The commitment output is the (only) address-less output of the
  // commitment tx; the registration spends it together with fresh funding.
  const summary = sdkUtils.summarizeSignedTransaction(commitment.signedTx, network);
  const commitmentIndex = summary.outputs.findIndex((out) => out.address === null);
  if (commitmentIndex === -1) {
    throw new IdentityProvisionError(
      "could not locate the commitment output in the commitment transaction (SDK drift?)",
    );
  }
  const commitmentOut = summary.outputs[commitmentIndex] as (typeof summary.outputs)[number];

  const fundingUtxos = (await fetchFundingUtxos(params.client, params.address)).filter(
    (utxo) => !(utxo.txid === commitment.txid && utxo.outputIndex === commitmentIndex),
  );
  const registration = sdk.registerIdentity({
    wif: params.wif,
    commitmentUtxo: {
      txid: commitment.txid,
      outputIndex: commitmentIndex,
      satoshis: commitmentOut.valueSat,
      script: commitmentOut.scriptHex,
    },
    commitmentData: commitment.commitmentData,
    primaryAddresses: [params.address],
    utxos: fundingUtxos,
    changeAddress: params.address,
    revocationAuthority: params.revocationAuthority,
    recoveryAuthority: params.recoveryAuthority,
    ...(params.referral !== undefined ? { referralChain: [params.referral] } : {}),
  });
  onStatus(`registration built (burns the protocol fee)`);
  // KNOWN BLOCKER (investigated 2026-07-13): the registration fee is an
  // implicit miner fee (~100 native, matching on-chain registrations), and
  // Verus's sendrawtransaction applies an identity-registration-specific
  // absurd-fee guard that allowhighfees does NOT lift — proven by contrast
  // with a plain 100-coin-fee tx, which IS accepted with the flag on the
  // same node. This call therefore throws "Transaction has absurd fees".
  // Left in place (with the flag) as the exact reproduction; see RISKS.md
  // → Etappe 6 for the evidence and the unblock options.
  const registrationClient = params.registrationClient ?? params.client;
  await registrationClient.call("sendrawtransaction", [registration.signedTx, true]);
  await waitForConfirmation(
    params.client,
    registration.txid,
    "identity registration",
    pollMs,
    deadline,
    onStatus,
  );

  // -- 3. verify ---------------------------------------------------------
  const lookup = (await params.client.call("getidentity", [`${params.name}@`])) as {
    identity?: { identityaddress?: string; revocationauthority?: string };
  };
  const registered = lookup.identity?.identityaddress;
  if (registered !== commitment.identityAddress) {
    throw new IdentityProvisionError(
      `getidentity returned ${String(registered)} but the SDK computed ` +
        `${commitment.identityAddress} — investigate before using this identity.`,
    );
  }
  onStatus(`identity ${params.name}@ registered and verified on-chain`);
  return {
    identityAddress: commitment.identityAddress,
    identityName: `${params.name}@`,
    commitmentTxid: commitment.txid,
    registrationTxid: registration.txid,
  };
}
