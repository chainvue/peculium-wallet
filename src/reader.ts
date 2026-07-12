/**
 * The read boundary — chain queries that never move money.
 *
 * The MCP read tools talk to the `WalletReader` INTERFACE only, mirroring
 * the `WalletBackend` seam: tests inject a `MockReader`, production wires
 * the `PublicNodeReader` over verus-rpc. Reads are best-effort by nature —
 * a lying or stale public node can misreport balances and confirmations
 * (RISKS.md "public node trust") but can never approve or execute a spend;
 * every money decision goes through the gate and the local ledger.
 */

import { VerusRpcError, type VerusClient } from "verus-rpc";

/** One currency's balance at an address, in satoshis. */
export interface CurrencyBalance {
  currency: string;
  sats: bigint;
}

/** The MCP layer's view of chain reads. */
export interface WalletReader {
  /** Per-currency confirmed balances of one address (native always included). */
  getBalances(address: string): Promise<CurrencyBalance[]>;
  /**
   * Confirmation count of a txid: 0 while in the mempool, null when the
   * node does not know the transaction at all.
   */
  getConfirmations(txid: string): Promise<number | null>;
}

/**
 * `WalletReader` over a public Verus node (or any daemon) via verus-rpc.
 * Uses only methods the public gateways whitelist: `getaddressbalance`
 * and `getrawtransaction`.
 */
export class PublicNodeReader implements WalletReader {
  private readonly client: VerusClient;
  private readonly nativeCurrency: string;

  constructor(client: VerusClient, nativeCurrency: string) {
    this.client = client;
    this.nativeCurrency = nativeCurrency;
  }

  async getBalances(address: string): Promise<CurrencyBalance[]> {
    const result = await this.client.addressIndex.getAddressBalance({ addresses: [address] });
    // `balance` (satoshi integer on the wire) is authoritative for the
    // native currency; `currencybalance` repeats it as an 8-decimal value,
    // so the native key is skipped below to avoid double reporting.
    const balances: CurrencyBalance[] = [{ currency: this.nativeCurrency, sats: result.balance }];
    const perCurrency = Object.entries(result.currencybalance ?? {}).filter(
      ([currency]) => currency !== this.nativeCurrency,
    );
    perCurrency.sort(([a], [b]) => a.localeCompare(b));
    for (const [currency, sats] of perCurrency) {
      balances.push({ currency, sats });
    }
    return balances;
  }

  async getConfirmations(txid: string): Promise<number | null> {
    let raw: unknown;
    try {
      raw = await this.client.call("getrawtransaction", [txid, 1]);
    } catch (error) {
      // -5 = RPC_INVALID_ADDRESS_OR_KEY: "No information available about
      // transaction" — the node does not know this txid.
      if (error instanceof VerusRpcError && error.code === -5) {
        return null;
      }
      throw error;
    }
    const confirmations = (raw as { confirmations?: unknown }).confirmations;
    return typeof confirmations === "number" && Number.isFinite(confirmations)
      ? Math.max(0, Math.floor(confirmations))
      : 0;
  }
}

/**
 * Scriptable in-memory reader for tests and dev composition. Set
 * `balances` / `confirmations` directly; `failWith` makes every call throw
 * (the read-tool error paths).
 */
export class MockReader implements WalletReader {
  balances: CurrencyBalance[] = [];
  /** txid → confirmations; a missing txid reads as unknown (null). */
  readonly confirmations = new Map<string, number>();
  /** When set, every call rejects with this error. */
  failWith: Error | null = null;

  getBalances(): Promise<CurrencyBalance[]> {
    return this.failWith !== null
      ? Promise.reject(this.failWith)
      : Promise.resolve(this.balances);
  }

  getConfirmations(txid: string): Promise<number | null> {
    return this.failWith !== null
      ? Promise.reject(this.failWith)
      : Promise.resolve(this.confirmations.get(txid) ?? null);
  }
}
