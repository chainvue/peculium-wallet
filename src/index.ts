// @chainvue/peculium — public library surface.
//
// Peculium is an MCP server + CLI that lets an AI agent move Verus money
// inside human-configured, agent-immutable policy. Lite architecture:
// local offline signing + public nodes; the spending key never appears in
// env or in any MCP tool. See DESIGN.md / RISKS.md.
//
// Etappe 1: the domain core — errors, typed intents, compiled hard caps,
// policy schema, state schema and the pure policy engine.
// Etappe 2: the append-only spend ledger, state IO and the audit trail.
// The exports grow per Etappe (E3 gate, E4 buildMcpServer, ...).

export {
  AuditLog,
  auditLineSchema,
  type AuditEvent,
  type AuditLine,
} from "./audit.js";
export {
  PeculiumError,
  PolicyLimitError,
  PolicyParseError,
  StateParseError,
} from "./errors.js";
export {
  ambiguousRecordSchema,
  broadcastRecordSchema,
  confirmedRecordSchema,
  failedRecordSchema,
  LedgerRecordError,
  ledgerRecordSchema,
  parseLedgerLine,
  pendingRecordSchema,
  resolvedRecordSchema,
  type AmbiguousCause,
  type AmbiguousRecord,
  type BroadcastRecord,
  type ConfirmedRecord,
  type FailedRecord,
  type FailureDetail,
  type FailureStage,
  type LedgerRecord,
  type PendingRecord,
  type ResolvedBy,
  type ResolvedOutcome,
  type ResolvedRecord,
  type SpendApproval,
} from "./ledger/records.js";
export {
  LedgerCorruptError,
  LedgerLockedError,
  LedgerStateError,
  SpendLedger,
  type RequestSnapshot,
  type RequestState,
} from "./ledger/ledger.js";
export {
  amountStringSchema,
  intentFingerprint,
  rawSpendInputSchema,
  REQUEST_ID_PATTERN,
  requestIdSchema,
  type RawSpendInput,
  type SendIntent,
  type SpendIntent,
  type TopupIntent,
} from "./intents.js";
export {
  HARD_CAPS,
  hardCapsFor,
  nativeCurrencyOf,
  STARTER_HARD_CAPS,
  SUPPORTED_CHAINS,
  type AddressMode,
  type HardCaps,
  type SupportedChain,
} from "./limits.js";
export {
  evaluatePolicy,
  type ConfirmReason,
  type Decision,
  type DenyCode,
  type LedgerView,
} from "./policy/engine.js";
export {
  parsePolicy,
  policyFileSchema,
  type CurrencyPolicy,
  type FacilitatorPolicy,
  type Policy,
  type PolicyFileInput,
  type RatePolicy,
  type RecipientPolicy,
} from "./policy/schema.js";
export {
  INITIAL_STATE,
  parseState,
  serializeState,
  stateFileSchema,
  type Grant,
  type StateFile,
  type WalletState,
} from "./state.js";
export { depleteGrant, readState, writeState } from "./state-io.js";

export const PECULIUM_VERSION = "0.0.0";
