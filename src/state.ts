/**
 * `state.json` — the wallet's tiny mutable operator state: the arm window
 * (`peculium arm`) and the active session grant (`peculium grant`). Pure
 * types + parse/serialize only; file IO, locking and atomic writes belong
 * to the E2 state store.
 *
 * `remainingSats` is serialized as a plain integer-satoshi string (not a
 * decimal coin amount): the grant depletes in exact satoshi steps and a
 * string survives JSON without precision questions.
 */

import { z } from "zod";

import { StateParseError } from "./errors.js";

/** An active session budget (CLI `peculium grant`), depleted per spend. */
export interface Grant {
  /** The single currency this grant covers. */
  currency: string;
  /** What is left of the granted budget, in satoshis. */
  remainingSats: bigint;
  /** ISO timestamp; at/after this instant the grant no longer exists. */
  expiresAt: string;
}

export interface WalletState {
  schemaVersion: 1;
  /** ISO timestamp until which the wallet is armed, or null (disarmed). */
  armedUntil: string | null;
  /** The active grant, or null. Expiry is evaluated by the engine, not here. */
  grant: Grant | null;
}

const satsStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be a non-negative integer satoshi string")
  .transform((value) => BigInt(value));

const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const stateFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  armedUntil: isoDateTimeSchema.nullable(),
  grant: z
    .strictObject({
      currency: z.string().min(1),
      remainingSats: satsStringSchema,
      expiresAt: isoDateTimeSchema,
    })
    .nullable(),
});

/** The JSON-safe `state.json` shape. */
export type StateFile = z.input<typeof stateFileSchema>;

/** The state of a freshly initialized wallet: disarmed, no grant. */
export const INITIAL_STATE: WalletState = Object.freeze({
  schemaVersion: 1 as const,
  armedUntil: null,
  grant: null,
});

/**
 * Parse decoded `state.json` content. Throws `StateParseError` on any
 * mismatch — a corrupt state file must stop the wallet, not default to
 * "disarmed but otherwise fine".
 */
export function parseState(json: unknown): WalletState {
  const result = stateFileSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join(".");
        return path === "" ? issue.message : `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new StateParseError(`state.json is invalid: ${detail}`);
  }
  return result.data;
}

/** Convert runtime state back to the JSON-safe file shape. */
export function serializeState(state: WalletState): StateFile {
  return {
    schemaVersion: state.schemaVersion,
    armedUntil: state.armedUntil,
    grant:
      state.grant === null
        ? null
        : {
            currency: state.grant.currency,
            remainingSats: state.grant.remainingSats.toString(),
            expiresAt: state.grant.expiresAt,
          },
  };
}
