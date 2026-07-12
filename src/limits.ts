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

import { parseAmount } from "verus-rpc";

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
 * The chain-native currency of a PBaaS chain shares the chain's name
 * (VRSCTEST's native coin is "VRSCTEST"). Centralized here so the "is this
 * intent in the native currency?" question has exactly one answer.
 */
export function nativeCurrencyOf(chain: SupportedChain): string {
  return chain;
}
