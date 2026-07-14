/**
 * The read boundary — chain queries that never move money.
 *
 * The MCP read tools talk to the `WalletReader` INTERFACE only, mirroring
 * the `WalletBackend` seam: tests inject a `MockReader`, production wires
 * the `PublicNodeReader` over verus-rpc. Reads are best-effort by nature —
 * a lying or stale public node can misreport balances and confirmations
 * (RISKS.md "public node trust") but can never approve or execute a spend;
 * every money decision goes through the gate and the local ledger.
 *
 * Friendly names (`getFriendlyName`) are a DISPLAY AID only: they come from
 * the untrusted node and must never feed a policy decision — the i-address
 * stays the invariant everywhere money is decided (UX-GAPS #10).
 */

import { VerusRpcError, type VerusClient } from "@chainvue/verus-rpc";

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
  /**
   * Best-effort reverse lookup of an identity i-address to its friendly
   * name (`name@`). Returns null for non-identity addresses, unknown
   * identities, or on any node failure — callers show the raw address then.
   */
  getFriendlyName(iAddress: string): Promise<string | null>;
  /** Current chain height (for identity-signature embedding); null on failure. */
  getBlockHeight(): Promise<number | null>;
}

/**
 * `WalletReader` over a public Verus node (or any daemon) via verus-rpc.
 * Uses only methods the public gateways whitelist: `getaddressbalance`,
 * `getrawtransaction`, `getidentity`, `getblockcount`.
 */
export class PublicNodeReader implements WalletReader {
  private readonly client: VerusClient;
  private readonly nativeCurrency: string;
  private readonly nativeCurrencyId: string | null;
  /** name cache: i-address → { name, atMs } (display-only, short TTL). */
  private readonly nameCache = new Map<string, { name: string | null; atMs: number }>();
  private readonly nameTtlMs: number;

  constructor(
    client: VerusClient,
    nativeCurrency: string,
    nativeCurrencyId: string | null = null,
    nameTtlMs = 60_000,
  ) {
    this.client = client;
    this.nativeCurrency = nativeCurrency;
    this.nativeCurrencyId = nativeCurrencyId;
    this.nameTtlMs = nameTtlMs;
  }

  async getBalances(address: string): Promise<CurrencyBalance[]> {
    const result = await this.client.addressIndex.getAddressBalance({ addresses: [address] });
    // `balance` (satoshi integer on the wire) is authoritative for the
    // native currency; `currencybalance` repeats it both under the native
    // NAME and (for identity addresses) under the native currency's
    // i-ADDRESS — skip both to avoid double reporting (UX-GAPS: the
    // duplicate was misread as the agent's own identity address).
    const balances: CurrencyBalance[] = [{ currency: this.nativeCurrency, sats: result.balance }];
    const perCurrency = Object.entries(result.currencybalance ?? {}).filter(
      ([currency]) => currency !== this.nativeCurrency && currency !== this.nativeCurrencyId,
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

  async getFriendlyName(iAddress: string): Promise<string | null> {
    if (!iAddress.startsWith("i")) {
      return null;
    }
    const cached = this.nameCache.get(iAddress);
    if (cached !== undefined && Date.now() - cached.atMs < this.nameTtlMs) {
      return cached.name;
    }
    let name: string | null = null;
    try {
      const lookup = (await this.client.call("getidentity", [iAddress])) as {
        friendlyname?: string;
        identity?: { name?: string };
      };
      // `friendlyname` is fully qualified ("name.VRSCTEST@"); strip the
      // native chain suffix for the root-identity display form ("name@").
      const friendly = lookup.friendlyname;
      if (typeof friendly === "string" && friendly.endsWith("@")) {
        name = friendly.replace(/\.(VRSCTEST|VRSC)@$/i, "@");
      } else if (typeof lookup.identity?.name === "string") {
        name = `${lookup.identity.name}@`;
      }
    } catch {
      name = null; // unknown identity or node failure — display the address
    }
    this.nameCache.set(iAddress, { name, atMs: Date.now() });
    return name;
  }

  async getBlockHeight(): Promise<number | null> {
    try {
      const count = await this.client.call("getblockcount", []);
      return typeof count === "number" && Number.isFinite(count) ? count : null;
    } catch {
      return null;
    }
  }
}

/**
 * Scriptable in-memory reader for tests and dev composition. Set
 * `balances` / `confirmations` / `names` directly; `failWith` makes every
 * call throw (the read-tool error paths).
 */
export class MockReader implements WalletReader {
  balances: CurrencyBalance[] = [];
  /** txid → confirmations; a missing txid reads as unknown (null). */
  readonly confirmations = new Map<string, number>();
  /** i-address → friendly name; missing reads as unresolvable (null). */
  readonly names = new Map<string, string>();
  blockHeight: number | null = 1_000_000;
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

  getFriendlyName(iAddress: string): Promise<string | null> {
    return this.failWith !== null
      ? Promise.reject(this.failWith)
      : Promise.resolve(this.names.get(iAddress) ?? null);
  }

  getBlockHeight(): Promise<number | null> {
    return this.failWith !== null
      ? Promise.reject(this.failWith)
      : Promise.resolve(this.blockHeight);
  }
}
