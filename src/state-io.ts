/**
 * `state.json` IO — the file plumbing around the pure parse/serialize in
 * state.ts. Reads fail closed (a corrupt file throws, it never defaults to
 * "disarmed but otherwise fine"); writes are atomic (temp file + rename)
 * so a crash mid-write can never leave a half-written state on disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { StateParseError } from "./errors.js";
import { INITIAL_STATE, parseState, serializeState, type WalletState } from "./state.js";

const STATE_FILE = "state.json";

/**
 * Read `state.json` from the config dir. A missing file is the one benign
 * case (a fresh wallet is disarmed with no grant); anything else that is
 * not a valid state file throws `StateParseError`.
 */
export function readState(dir: string): WalletState {
  const filePath = path.join(dir, STATE_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return INITIAL_STATE;
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new StateParseError(`state.json is not valid JSON: ${detail}`);
  }
  return parseState(json);
}

/**
 * Atomically write `state.json` (0600): write + fsync a temp file in the
 * same directory, then rename over the target. Readers see either the old
 * or the new state, never a torn one.
 */
export function writeState(dir: string, state: WalletState): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const finalPath = path.join(dir, STATE_FILE);
  const tempPath = path.join(dir, `${STATE_FILE}.tmp-${process.pid}`);
  const payload = `${JSON.stringify(serializeState(state), null, 2)}\n`;
  const fd = fs.openSync(tempPath, "w", 0o600);
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, finalPath);
}

/**
 * Deplete the active grant by a spend, pure (persisting the result is the
 * caller's `writeState`). No-op when there is no grant or the grant covers
 * a different currency (the engine already denied any real mismatch — an
 * expired grant simply no longer constrains, and depleting it changes
 * nothing). Only positive amounts deplete; the remainder floors at 0.
 */
export function depleteGrant(
  state: WalletState,
  currency: string,
  amountSats: bigint,
): WalletState {
  const grant = state.grant;
  if (grant === null || grant.currency !== currency || amountSats <= 0n) {
    return state;
  }
  const remaining = grant.remainingSats - amountSats;
  return {
    ...state,
    grant: { ...grant, remainingSats: remaining > 0n ? remaining : 0n },
  };
}
