/**
 * Peculium error taxonomy — deliberately small (verus-rpc convention).
 *
 * Every error carries a stable machine-readable `code` so the MCP layer and
 * CLI can branch without string-matching messages. The split that matters:
 * a *policy violation at runtime* is NOT an error — the engine returns a
 * deny `Decision` (see policy/engine.ts). Errors are reserved for malformed
 * or forbidden *configuration and state*, where the only safe behavior is
 * to refuse to operate at all (fail closed).
 */

/** Human-readable detail of an unknown thrown value (never throws itself). */
export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Base class for all Peculium errors; `code` is stable across releases. */
export class PeculiumError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PeculiumError";
    this.code = code;
  }
}

/**
 * The policy file asks for more than the compiled hard caps allow (e.g. a
 * chain-native cap above `HARD_CAPS`). Refused at load time so that a
 * hand-edited `policy.json` — the host's file tools can reach it, see
 * RISKS.md — can never widen the file-edit-proof ceiling.
 */
export class PolicyLimitError extends PeculiumError {
  constructor(message: string) {
    super("policy-limit", message);
    this.name = "PolicyLimitError";
  }
}

/**
 * `policy.json` did not match the strict schema. The gate treats a policy
 * that fails to (re)load as absent: every spend is denied until a human
 * fixes the file.
 */
export class PolicyParseError extends PeculiumError {
  constructor(message: string) {
    super("policy-parse", message);
    this.name = "PolicyParseError";
  }
}

/**
 * `state.json` (arm window + grant) did not match the strict schema. Same
 * fail-closed consequence as a policy parse failure.
 */
export class StateParseError extends PeculiumError {
  constructor(message: string) {
    super("state-parse", message);
    this.name = "StateParseError";
  }
}
