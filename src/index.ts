// @chainvue/peculium-wallet — public library surface.
//
// Peculium is an MCP server + CLI that lets an AI agent move Verus money
// inside human-configured, agent-immutable policy. Lite architecture:
// local offline signing + public nodes; the spending key never appears in
// env or in any MCP tool. See DESIGN.md / RISKS.md.
//
// Etappe 1: the domain core — errors, typed intents, compiled hard caps,
// policy schema, state schema and the pure policy engine.
// Etappe 2: the append-only spend ledger, state IO and the audit trail.
// Etappe 3: policy file IO, the confirm/backend boundaries and the gate.
// Etappe 4: the MCP surface — server builder, elicitation confirmer and
//           the read seam (WalletReader / PublicNodeReader).
// The exports grow per Etappe (E3b LiteBackend, E5 CLI, ...).

export {
  AuditLog,
  auditLineSchema,
  type AuditEvent,
  type AuditLine,
} from "./audit.js";
export {
  MockBackend,
  SpendRejectedError,
  SpendUncertainError,
  UnavailableBackend,
  type SpendInstruction,
  type SpendReceipt,
  type WalletBackend,
} from "./backend.js";
export {
  renderConfirmMessage,
  renderPaidFetchConfirmMessage,
  StaticConfirmer,
  type ConfirmContext,
  type Confirmer,
  type ConfirmOutcome,
  type PaidFetchConfirmContext,
} from "./confirm.js";
export {
  PeculiumError,
  PolicyLimitError,
  PolicyParseError,
  StateParseError,
} from "./errors.js";
export {
  WalletGate,
  type GateDenyCode,
  type GateOutcome,
  type WalletGateDeps,
} from "./gate.js";
export { LiteBackend, type LiteBackendDeps } from "./lite-backend.js";
export {
  createKeystoreFile,
  KeystoreError,
  KeystoreExistsError,
  keystoreFileSchema,
  KeystoreMissingError,
  KeystoreUnlockError,
  readKeystoreFile,
  unlockKeystore,
  writeKeystoreFile,
  type KeystoreFile,
} from "./keystore.js";
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
  settledRecordSchema,
  type AmbiguousCause,
  type AmbiguousRecord,
  type BroadcastRecord,
  type ConfirmedRecord,
  type FailedRecord,
  type FailureDetail,
  type FailureStage,
  type LedgerRecord,
  type PendingRecord,
  type RequestKind,
  type ResolvedBy,
  type ResolvedOutcome,
  type ResolvedRecord,
  type SettledRecord,
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
  type MoneyIntent,
  type PaidFetchIntent,
  type RawSpendInput,
  type SendIntent,
  type SpendIntent,
  type TopupIntent,
} from "./intents.js";
export {
  HARD_CAPS,
  hardCapsFor,
  nativeCurrencyOf,
  PAID_FETCH_HARD_CAPS,
  paidFetchHardCapsFor,
  STARTER_HARD_CAPS,
  STARTER_PAID_FETCH_HARD_CAPS,
  SUPPORTED_CHAINS,
  type AddressMode,
  type HardCaps,
  type PaidFetchHardCaps,
  type SupportedChain,
} from "./limits.js";
export {
  evaluatePaidFetch,
  evaluatePolicy,
  type ConfirmReason,
  type Decision,
  type DenyCode,
  type LedgerView,
} from "./policy/engine.js";
export {
  MockPaymentBackend,
  parse402Offer,
  PaymentRejectedError,
  PaymentSetupError,
  PaymentUncertainError,
  V402PaymentBackend,
  type PaidRequest,
  type PaidResponse,
  type PaymentBackend,
  type PaymentOffer,
  type PreflightResult,
  type V402PaymentBackendDeps,
} from "./payment.js";
export {
  PaymentGate,
  type PaidFetchOutcome,
  type PaidFetchRequest,
  type PaymentGateDenyCode,
  type PaymentGateDeps,
} from "./payment-gate.js";
export {
  buildMcpServer,
  ElicitationConfirmer,
  PECULIUM_SERVER_NAME,
  type PeculiumServerDeps,
} from "./mcp.js";
export {
  loadPolicy,
  PolicyMissingError,
  PolicySource,
  type LoadedPolicy,
  type PolicyRefreshResult,
} from "./policy/load.js";
export {
  MockReader,
  PublicNodeReader,
  type CurrencyBalance,
  type WalletReader,
} from "./reader.js";
export {
  parsePolicy,
  policyFileSchema,
  type CurrencyPolicy,
  type FacilitatorPolicy,
  type Policy,
  type PolicyFileInput,
  type RatePolicy,
  type RecipientPolicy,
  type ServicePolicy,
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
