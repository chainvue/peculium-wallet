/**
 * Compiled hard caps — the file-edit-proof ceiling.
 *
 * RISKS.md: a prompt-injected host with file permissions can edit
 * `policy.json`; it cannot edit constants baked into the installed build.
 * `parsePolicy` refuses any policy whose chain-native caps exceed these,
 * and the engine re-checks them per intent (defense in depth).
 *
 * Non-native currencies deliberately have NO compiled cap: the code cannot
 * know an arbitrary PBaaS token's value, so they are bounded solely by the
 * mandatory per-currency policy entries — a currency without an entry is
 * unspendable (fail closed; PLAN.md decision #4).
 */

import { NETWORK_CONFIG } from "@chainvue/verus-sdk";
import { parseAmount } from "@chainvue/verus-rpc";

/**
 * Chains this build will operate on. Mainnet is refused by compilation,
 * not by configuration (DESIGN.md §10 decision 10).
 */
export const SUPPORTED_CHAINS = ["VRSCTEST"] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

/**
 * How the agent's spending address was provisioned. "verusid" has cold
 * revocation/recovery authorities; "starter-r-address" is a plain keypair
 * with NO recovery path, so it gets a much smaller compiled ceiling.
 */
export type AddressMode = "starter-r-address" | "verusid";

/** A per-transaction / trailing-24h / lifetime cap triple, in satoshis. */
export interface HardCaps {
  readonly maxPerTxSats: bigint;
  readonly maxPerDaySats: bigint;
  readonly maxTotalSats: bigint;
}

/** Hard caps for the chain-native currency in VerusID mode. */
export const HARD_CAPS: HardCaps = Object.freeze({
  maxPerTxSats: parseAmount("10"),
  maxPerDaySats: parseAmount("50"),
  maxTotalSats: parseAmount("250"),
});

/**
 * Hard caps in starter mode (plain R-address). Key loss or theft is final
 * here — no revocation, no recovery — so the ceiling is deliberately tiny
 * (RISKS.md "starter mode" watch item).
 */
export const STARTER_HARD_CAPS: HardCaps = Object.freeze({
  maxPerTxSats: parseAmount("1"),
  maxPerDaySats: parseAmount("5"),
  maxTotalSats: parseAmount("25"),
});

/** The compiled ceiling that applies to a given address mode. */
export function hardCapsFor(mode: AddressMode): HardCaps {
  return mode === "starter-r-address" ? STARTER_HARD_CAPS : HARD_CAPS;
}

/**
 * A per-call / trailing-24h cap pair for OFF-CHAIN v402 payments
 * (`wallet_paid_fetch`), in satoshis. Deliberately separate from
 * {@link HardCaps}: paid-fetch burns PREPAID credit that already left the
 * wallet at topup time (where the on-chain caps applied), so these bound
 * the RATE of burning that credit — they never double-count against the
 * wallet-fund caps. No lifetime cap: the lifetime bound IS the sum of
 * capped topups.
 */
export interface PaidFetchHardCaps {
  readonly maxPerCallSats: bigint;
  readonly maxPerDaySats: bigint;
}

/** Paid-fetch hard caps for the chain-native currency in VerusID mode. */
export const PAID_FETCH_HARD_CAPS: PaidFetchHardCaps = Object.freeze({
  maxPerCallSats: parseAmount("1"),
  maxPerDaySats: parseAmount("25"),
});

/** Paid-fetch hard caps in starter mode (same rationale as STARTER_HARD_CAPS). */
export const STARTER_PAID_FETCH_HARD_CAPS: PaidFetchHardCaps = Object.freeze({
  maxPerCallSats: parseAmount("0.25"),
  maxPerDaySats: parseAmount("5"),
});

/** The compiled paid-fetch ceiling that applies to a given address mode. */
export function paidFetchHardCapsFor(mode: AddressMode): PaidFetchHardCaps {
  return mode === "starter-r-address" ? STARTER_PAID_FETCH_HARD_CAPS : PAID_FETCH_HARD_CAPS;
}

/**
 * The chain-native currency of a PBaaS chain shares the chain's name
 * (VRSCTEST's native coin is "VRSCTEST"). Centralized here so the "is this
 * intent in the native currency?" question has exactly one answer.
 */
export function nativeCurrencyOf(chain: SupportedChain): string {
  return chain;
}

/**
 * The v402 WIRE identifier of a chain. The protocol's canonical payload
 * requires a lowercase network id (`^[a-z0-9]+$`) and facilitators emit
 * offers accordingly ("vrsctest"), while the wallet's {@link SupportedChain}
 * keeps the chain's canonical uppercase name. Centralized here so every
 * offer-vs-policy network comparison uses exactly one mapping.
 */
export function wireNetworkOf(chain: SupportedChain): string {
  return chain.toLowerCase();
}

/**
 * The v402 identity-signature system id (chain id) of a chain. An exhaustive
 * switch so a new {@link SupportedChain} member is a compile error here
 * rather than silently defaulting to the wrong chain's id.
 */
export function systemIdOf(chain: SupportedChain): string {
  switch (chain) {
    case "VRSCTEST":
      return NETWORK_CONFIG.testnet.chainId;
  }
}

/**
 * Whether an intent/offer currency is the chain's native coin — the ONLY
 * currency the compiled hard caps bound. Case-insensitive on purpose: the
 * compiled ceiling is the file-edit-proof defense, so a policy (or a 402
 * offer) that spells the native currency in a different case must not slip
 * past it. Non-native currencies are bounded solely by their policy entry.
 */
export function isNativeCurrency(currency: string, chain: SupportedChain): boolean {
  return currency.toLowerCase() === nativeCurrencyOf(chain).toLowerCase();
}
