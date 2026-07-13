/**
 * LiteBackend — the E3b execution path: public-node reads, offline signing.
 *
 * Sequence per spend (each step's failure disposition in brackets):
 *
 *  1. passphrase + keystore + address check            [build ⇒ rejected]
 *  2. currency resolution (name → i-address)           [build ⇒ rejected]
 *  3. UTXO fetch, exclusions, unconfirmed own change   [build ⇒ rejected]
 *  4. offline build + sign via the SDK (validator-checked)  [build ⇒ rejected]
 *  5. `sendrawtransaction`                             [daemon error ⇒ rejected,
 *                                                       transport error ⇒ UNCERTAIN]
 *
 * Everything before step 5 is a PROVEN no-op — no bytes have left the
 * machine, so failures release the gate's reservation. Only the broadcast
 * itself can end uncertain (the fail-closed `ambiguous` path).
 *
 * Key handling: the WIF is decrypted after all network reads, used for one
 * signing call and dereferenced immediately. JS cannot zeroize strings —
 * the residual exposure is the documented v1 trade-off (RISKS.md "key in
 * process"); the v2 signer daemon is the fix.
 */

import { NETWORK_CONFIG, VerusSDK, utils as sdkUtils } from "@chainvue/verus-typescript-sdk";
import { TransportError, VerusRpcError, type VerusClient } from "verus-rpc";

import {
  SpendRejectedError,
  SpendUncertainError,
  type SpendInstruction,
  type SpendReceipt,
  type WalletBackend,
} from "./backend.js";
import { readKeystoreFile, unlockKeystore } from "./keystore.js";
import { nativeCurrencyOf, type SupportedChain } from "./limits.js";

/** The SDK's UTXO input shape (satoshis as a plain number). */
interface SdkUtxo {
  txid: string;
  outputIndex: number;
  satoshis: number;
  script: string;
  height?: number;
}

export interface LiteBackendDeps {
  /** RPC client pointed at a node that serves the light-client method set. */
  client: VerusClient;
  /** Config dir holding `keystore.json`. */
  dir: string;
  chain: SupportedChain;
  /**
   * Passphrase provider, read AT SPEND TIME (never cached). Defaults to
   * `process.env.PECULIUM_KEYSTORE_PASSPHRASE`.
   */
  passphrase?: () => string | undefined;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `Utxo.satoshis` crosses into the SDK as a number; refuse unsafe values. */
function toSafeNumber(sats: bigint, what: string): number {
  const value = Number(sats);
  if (!Number.isSafeInteger(value)) {
    throw new SpendRejectedError("build", `${what} exceeds the safe integer range: ${sats}`);
  }
  return value;
}

/** The v1 lite execution backend. See the module doc for the sequence. */
export class LiteBackend implements WalletBackend {
  private readonly deps: LiteBackendDeps;
  private readonly sdk: VerusSDK;
  private readonly network: "mainnet" | "testnet";

  constructor(deps: LiteBackendDeps) {
    this.deps = deps;
    // v1 whitelists VRSCTEST only (limits.ts); the mapping stays explicit
    // so a future mainnet build cannot silently pick the wrong params.
    this.network = deps.chain === "VRSCTEST" ? "testnet" : "mainnet";
    this.sdk = new VerusSDK({ network: this.network });
  }

  async executeSpend(instruction: SpendInstruction): Promise<SpendReceipt> {
    // 1. Passphrase + keystore + address consistency — all local, all
    // definite no-ops on failure.
    const passphrase =
      this.deps.passphrase?.() ?? process.env["PECULIUM_KEYSTORE_PASSPHRASE"];
    if (passphrase === undefined || passphrase === "") {
      throw new SpendRejectedError(
        "build",
        "PECULIUM_KEYSTORE_PASSPHRASE is not set; the keystore cannot be unlocked. " +
          "Set it in the MCP host config. No funds were moved.",
      );
    }
    let keystore;
    try {
      keystore = readKeystoreFile(this.deps.dir);
    } catch (error) {
      throw new SpendRejectedError(
        "build",
        `the keystore could not be read: ${errorDetail(error)}. No funds were moved.`,
      );
    }
    if (keystore.address !== instruction.fromAddress) {
      throw new SpendRejectedError(
        "build",
        `the keystore holds the key for ${keystore.address}, but the policy's agent ` +
          `address is ${instruction.fromAddress} — refusing to sign (keystore/policy drift).`,
      );
    }
    if (!instruction.fromAddress.startsWith("R")) {
      // Identity-HELD funds (P2ID inputs) are not live-proven yet; the v1
      // agent address is the identity's primary R-address. Refusing here is
      // cheaper than discovering it at the node (RISKS.md, E6).
      throw new SpendRejectedError(
        "build",
        `agent address ${instruction.fromAddress} is not a transparent R-address; ` +
          `spending identity-held funds is not supported in v1 — use the identity's ` +
          `primary R-address as the agent address.`,
      );
    }

    // 2. Currency resolution: the chain-native currency signs by system id;
    // any other currency resolves name → i-address via the node (read-only,
    // still a definite no-op on failure).
    let currencyId: string;
    if (instruction.currency === nativeCurrencyOf(this.deps.chain)) {
      currencyId = sdkNativeId(this.network);
    } else {
      try {
        const definition = await this.deps.client.currency.getCurrency({
          currency: instruction.currency,
        });
        currencyId = definition.currencyid;
      } catch (error) {
        throw new SpendRejectedError(
          "build",
          `currency "${instruction.currency}" could not be resolved on the node: ` +
            `${errorDetail(error)}. No funds were moved.`,
        );
      }
    }

    // 3. UTXO fetch. Confirmed UTXOs first; in-flight inputs are excluded
    // (the ledger's outpoint discipline), and the gate's clean unconfirmed
    // change outpoints are recovered from the mempool when needed.
    const excluded = new Set(instruction.excludeOutpoints);
    let utxos: SdkUtxo[];
    try {
      const confirmed = await this.deps.client.addressIndex.getAddressUtxos({
        addresses: [instruction.fromAddress],
      });
      utxos = confirmed
        .filter((utxo) => !excluded.has(`${utxo.txid}:${utxo.outputIndex}`))
        // Zero-native UTXOs are identity definitions, name commitments or
        // similar structural outputs — they fund nothing and consuming one
        // could destroy an identity or a pending registration. Never touch.
        .filter((utxo) => utxo.satoshis > 0n)
        .map((utxo) => ({
          txid: utxo.txid,
          outputIndex: utxo.outputIndex,
          satoshis: toSafeNumber(utxo.satoshis, `utxo ${utxo.txid}:${utxo.outputIndex}`),
          script: utxo.script,
          height: utxo.height ?? 0,
        }));

      const present = new Set(utxos.map((utxo) => `${utxo.txid}:${utxo.outputIndex}`));
      const wantedChange = instruction.spendableUnconfirmedChange.filter(
        (outpoint) => !present.has(outpoint) && !excluded.has(outpoint),
      );
      if (wantedChange.length > 0) {
        utxos.push(...(await this.fetchUnconfirmedChange(instruction, wantedChange)));
      }
    } catch (error) {
      if (error instanceof SpendRejectedError) {
        throw error;
      }
      throw new SpendRejectedError(
        "build",
        `UTXOs could not be fetched from the node: ${errorDetail(error)}. No funds were moved.`,
      );
    }
    if (utxos.length === 0) {
      throw new SpendRejectedError(
        "build",
        "the agent address has no spendable UTXOs (in-flight outputs are reserved). " +
          "No funds were moved.",
      );
    }

    // 4. Offline build + sign. The SDK re-validates the funded tx against
    // the unfunded intent (utxo-lib's validator) before returning hex.
    let signedTx: string;
    let sdkTxid: string;
    try {
      const wif = unlockKeystore(keystore, passphrase);
      const built = this.sdk.sendCurrency(
        {
          wif,
          outputs: [
            {
              currency: currencyId,
              satoshis: instruction.amountSats.toString(),
              address: instruction.toAddress,
              addressType: instruction.toAddress.startsWith("i") ? "ID" : "PKH",
            },
          ],
          utxos,
          changeAddress: instruction.fromAddress,
        },
      );
      signedTx = built.signedTx;
      sdkTxid = built.txid;
    } catch (error) {
      throw new SpendRejectedError(
        "build",
        `the transaction could not be built/signed: ${errorDetail(error)}. No funds were moved.`,
      );
    }

    // 5. Broadcast — the only step that can end UNCERTAIN. A daemon error
    // body is a definite rejection; any transport-level failure after the
    // request started means the bytes MAY have reached the network.
    let daemonTxid: string;
    try {
      const result = await this.deps.client.call("sendrawtransaction", [signedTx]);
      daemonTxid = typeof result === "string" ? result : String(result);
    } catch (error) {
      if (error instanceof VerusRpcError) {
        throw new SpendRejectedError(
          "broadcast-rejected",
          `the node rejected the transaction: ${error.message}`,
          error.code,
        );
      }
      const detail =
        error instanceof TransportError ? `${error.reason}: ${error.message}` : errorDetail(error);
      throw new SpendUncertainError(`broadcast transport failure (${detail})`);
    }

    // The daemon accepted a tx — its txid is authoritative. A mismatch with
    // the SDK's computed txid would be an SDK bug worth loud logging, but
    // the money truth is what the node accepted.
    if (daemonTxid !== sdkTxid) {
      process.stderr.write(
        `peculium: txid mismatch after broadcast (daemon ${daemonTxid}, sdk ${sdkTxid}) — ` +
          `recording the daemon's.\n`,
      );
    }

    const summary = sdkUtils.summarizeSignedTransaction(signedTx, this.network);
    const spentOutpoints = summary.inputs.map((input) => `${input.txid}:${input.vout}`);
    // Change = the last output paying back to our own address. (The SDK
    // appends change after the recipient outputs, so "last" is exact even
    // for self-sends.)
    let changeOutpoint: string | null = null;
    for (let index = summary.outputs.length - 1; index >= 0; index -= 1) {
      if (summary.outputs[index]?.address === instruction.fromAddress) {
        changeOutpoint = `${daemonTxid}:${index}`;
        break;
      }
    }

    return { txid: daemonTxid, spentOutpoints, changeOutpoint };
  }

  /**
   * Recover clean unconfirmed own-change outpoints from the mempool. Own
   * change is always plain P2PKH to our own address, so the script is
   * derivable locally; amounts come from the mempool deltas.
   */
  private async fetchUnconfirmedChange(
    instruction: SpendInstruction,
    wanted: readonly string[],
  ): Promise<SdkUtxo[]> {
    const deltas = await this.deps.client.addressIndex.getAddressMempool({
      addresses: [instruction.fromAddress],
    });
    const script = sdkUtils.addressToScriptPubKey(instruction.fromAddress).toString("hex");
    const wantedSet = new Set(wanted);
    const out: SdkUtxo[] = [];
    for (const delta of deltas) {
      if (delta.satoshis <= 0n) {
        continue; // spends, not outputs
      }
      const outpoint = `${delta.txid}:${delta.index}`;
      if (!wantedSet.has(outpoint)) {
        continue;
      }
      out.push({
        txid: delta.txid,
        outputIndex: delta.index,
        satoshis: toSafeNumber(delta.satoshis, `mempool change ${outpoint}`),
        script,
        height: 0,
      });
    }
    return out;
  }
}

/** The SDK addresses the chain-native currency by its system i-address. */
function sdkNativeId(network: "mainnet" | "testnet"): string {
  return NETWORK_CONFIG[network].chainId;
}
