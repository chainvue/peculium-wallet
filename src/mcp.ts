/**
 * The MCP surface — the ONLY thing the LLM can touch (DESIGN.md §7).
 *
 * Seven tools, split by trust:
 *
 * - read-only, no gate: `wallet_balance`, `wallet_receive_address`,
 *   `wallet_list_recipients`, `wallet_transaction_status`;
 * - read-only dry-run: `wallet_precheck` — runs the pure engine only,
 *   NEVER reserves, never takes the gate mutex;
 * - money, full gate sequence: `wallet_topup_facilitator`, `wallet_send`.
 *
 * Boundary rules enforced here: the agent names a recipient, it never
 * supplies an address — resolution happens against the CURRENT policy and
 * the gate re-validates the resolved pair. Every tool output is JSON-safe
 * (bigint-free): amounts leave as 8-decimal strings via `formatAmount`.
 * Policy denials and failed spends are RESULTS, not protocol errors — the
 * agent is supposed to read and reason about them; `isError` is reserved
 * for infrastructure failures (unreadable policy, unreachable node).
 *
 * `ElicitationConfirmer` is the production `Confirmer`: MCP form-mode
 * elicitation with an explicit {approve, deny} enum and NO default (a
 * pre-filled answer invites rubber-stamping). No form capability ⇒
 * unavailable ⇒ the gate fails closed. Decline, cancel, timeout and
 * malformed answers all read as refusal.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { formatAmount, parseAmount } from "verus-rpc";
import { z } from "zod";

import type { AuditLog } from "./audit.js";
import type { WalletBackend } from "./backend.js";
import type { Confirmer, ConfirmOutcome } from "./confirm.js";
import { WalletGate, type GateOutcome } from "./gate.js";
import {
  amountStringSchema,
  requestIdSchema,
  type RawSpendInput,
  type SpendIntent,
} from "./intents.js";
import type { RequestSnapshot, SpendLedger } from "./ledger/ledger.js";
import { evaluatePolicy } from "./policy/engine.js";
import type { LoadedPolicy, PolicySource } from "./policy/load.js";
import type { Policy } from "./policy/schema.js";
import type { WalletReader } from "./reader.js";
import { readState } from "./state-io.js";

/** Read from package metadata at the composition point; fixed per build. */
export const PECULIUM_SERVER_NAME = "peculium";

/** `McpError.code` is a plain number on the wire; compare it as one. */
const REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout;

/**
 * Production confirmer: MCP form-mode elicitation against the connected
 * host. See the module doc for the fail-closed mapping rules.
 */
export class ElicitationConfirmer implements Confirmer {
  private readonly server: McpServer;

  constructor(server: McpServer) {
    this.server = server;
  }

  /**
   * True only when the host declared the form-elicitation capability during
   * initialize (SDK ≥ 1.29 requires `elicitation.form`, a stricter check
   * than DESIGN §8's `elicitation != null` — stricter is the safe side).
   */
  available(): boolean {
    return this.server.server.getClientCapabilities()?.elicitation?.form != null;
  }

  async confirm(message: string, timeoutMs: number): Promise<ConfirmOutcome> {
    if (!this.available()) {
      return "unavailable";
    }
    let result: Awaited<ReturnType<typeof this.server.server.elicitInput>>;
    try {
      result = await this.server.server.elicitInput(
        {
          message,
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                title: "Decision",
                description: "Approving moves real funds immediately and cannot be undone.",
                enum: ["approve", "deny"],
                enumNames: ["Approve this payment", "Deny"],
                // Deliberately no default: the human must pick.
              },
            },
            required: ["decision"],
          },
        },
        { timeout: timeoutMs },
      );
    } catch (error) {
      if (error instanceof McpError && error.code === REQUEST_TIMEOUT_CODE) {
        return "timeout";
      }
      // Channel broke mid-request (host dropped the elicitation, schema
      // validation failed, transport died) — nobody approved.
      return "unavailable";
    }
    if (result.action === "accept") {
      // Only the exact literal approves; anything else — including a
      // malformed or missing decision — is a refusal.
      return result.content?.["decision"] === "approve" ? "approved" : "denied";
    }
    // "decline" and "cancel" are both explicit non-approvals.
    return "denied";
  }
}

/** Everything the server composes over; the gate is built internally. */
export interface PeculiumServerDeps {
  policySource: PolicySource;
  ledger: SpendLedger;
  backend: WalletBackend;
  reader: WalletReader;
  audit: AuditLog;
  /** Config dir holding `state.json` (arm window + grant). */
  stateDir: string;
  /** Server version string surfaced in the MCP handshake. */
  version: string;
  /** Injectable clock for tests; defaults to the real one. */
  clock?: () => Date;
  /**
   * Confirmer override for tests; production default is the
   * {@link ElicitationConfirmer} bound to the created server.
   */
  confirmer?: Confirmer;
}

type ToolPayload = Record<string, unknown>;

interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: ToolPayload;
  isError?: boolean;
  [key: string]: unknown;
}

/** Result payload as both structured content and pretty-printed text. */
function ok(payload: ToolPayload): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** Infrastructure failure (NOT a policy deny — those are ok() payloads). */
function infraError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSON-safe view of a ledger snapshot (bigint amount → decimal string). */
function snapshotPayload(snapshot: RequestSnapshot): ToolPayload {
  return {
    requestId: snapshot.requestId,
    kind: snapshot.kind,
    state: snapshot.state,
    amount: formatAmount(snapshot.amountSats),
    currency: snapshot.currency,
    recipientName: snapshot.recipientName,
    recipientAddress: snapshot.recipientAddress,
    approval: snapshot.approval,
    txid: snapshot.txid,
    confirmations: snapshot.confirmations,
    failure: snapshot.failure,
    ambiguousCause: snapshot.ambiguousCause,
    resolution: snapshot.resolution,
    countsAsSpent: snapshot.countsAsSpent,
    requestedAt: snapshot.pendingAt,
  };
}

/** JSON-safe view of a gate outcome. */
function outcomePayload(outcome: GateOutcome): ToolPayload {
  switch (outcome.status) {
    case "committed":
      return {
        status: "committed",
        requestId: outcome.requestId,
        txid: outcome.txid,
        note: "The transaction was broadcast. Track it with wallet_transaction_status.",
      };
    case "denied":
      return {
        status: "denied",
        requestId: outcome.requestId,
        reasonCode: outcome.reasonCode,
        reason: outcome.humanText,
      };
    case "failed":
      return {
        status: "failed",
        requestId: outcome.requestId,
        stage: outcome.stage,
        reason: outcome.humanText,
      };
    case "ambiguous":
      return {
        status: "ambiguous",
        requestId: outcome.requestId,
        reason: outcome.humanText,
      };
    case "replayed":
      return {
        status: "replayed",
        requestId: outcome.requestId,
        note: "This requestId was already processed; this is the recorded outcome, no new spend happened.",
        priorOutcome: snapshotPayload(outcome.snapshot),
      };
  }
}

/** Shared raw-input shape of the money tools (agent names, never addresses). */
const spendInputShape = {
  requestId: requestIdSchema.describe(
    "Caller-chosen idempotency key (8-64 chars of [A-Za-z0-9._-]). Reuse it to safely retry; a known requestId never spends twice.",
  ),
  amount: amountStringSchema.describe('Exact decimal amount, e.g. "0.25". Max 8 decimals.'),
  currency: z.string().min(1).describe('Currency of the amount, e.g. "VRSCTEST".'),
  recipient: z
    .string()
    .min(1)
    .describe("Allowlist NAME of the destination (see wallet_list_recipients) — never an address."),
};

/**
 * Build the Peculium MCP server over the given collaborators. The wallet
 * gate is constructed here so the production confirmer can be bound to the
 * server it elicits through.
 */
export function buildMcpServer(deps: PeculiumServerDeps): McpServer {
  const { policySource, ledger, reader, audit, stateDir } = deps;
  const clock = deps.clock ?? (() => new Date());

  const server = new McpServer(
    { name: PECULIUM_SERVER_NAME, version: deps.version },
    {
      instructions:
        "Peculium moves real Verus money under an operator-configured policy you cannot " +
        "change. Recipients are named allowlist entries (wallet_list_recipients); amounts " +
        "are decimal strings. Use wallet_precheck to test an intent before spending. " +
        "Denials are final — do not retry a denied intent with varied parameters.",
    },
  );

  const confirmer = deps.confirmer ?? new ElicitationConfirmer(server);
  const gate = new WalletGate({
    policySource,
    ledger,
    backend: deps.backend,
    confirmer,
    audit,
    stateDir,
    clock,
  });

  /** Refresh the policy (audit on change) — throws like PolicySource.refresh. */
  function refreshPolicy(): LoadedPolicy {
    const refreshed = policySource.refresh();
    if (refreshed.changed) {
      audit.write({
        event: "policy-reload",
        oldHash: refreshed.previousHash,
        newHash: refreshed.policy.policyHash,
      });
    }
    return refreshed.policy;
  }

  /** The allowlist NAME → address resolution; null when not listed. */
  function resolveRecipient(
    kind: "topup" | "send",
    name: string,
    policy: Policy,
  ): string | null {
    const entries = kind === "topup" ? policy.facilitators : policy.recipients;
    return entries.find((entry) => entry.name === name)?.address ?? null;
  }

  function buildIntent(
    kind: "topup" | "send",
    input: RawSpendInput,
    recipientAddress: string,
  ): SpendIntent {
    return {
      kind,
      requestId: input.requestId,
      amountSats: parseAmount(input.amount),
      currency: input.currency,
      recipientAddress,
      recipientName: input.recipient,
    };
  }

  function notListedPayload(kind: "topup" | "send", input: RawSpendInput): ToolPayload {
    return {
      status: "denied",
      requestId: input.requestId,
      reasonCode: kind === "topup" ? "facilitator-not-listed" : "recipient-not-listed",
      reason:
        `"${input.recipient}" is not on the ${kind === "topup" ? "facilitator" : "recipient"} ` +
        `allowlist. Call wallet_list_recipients for the configured names; only the operator ` +
        `can add entries (peculium CLI).`,
    };
  }

  /** The shared money path: resolve → intent → full gate sequence. */
  async function executeMoney(kind: "topup" | "send", input: RawSpendInput): Promise<ToolResult> {
    let loaded: LoadedPolicy;
    try {
      loaded = refreshPolicy();
    } catch (error) {
      return ok({
        status: "denied",
        requestId: input.requestId,
        reasonCode: "policy-unreadable",
        reason: `The policy could not be loaded; every spend is denied until a human fixes it: ${errorDetail(error)}`,
      });
    }
    const address = resolveRecipient(kind, input.recipient, loaded.policy);
    if (address === null) {
      return ok(notListedPayload(kind, input));
    }
    const outcome = await gate.execute(buildIntent(kind, input, address));
    return ok(outcomePayload(outcome));
  }

  // ---------------------------------------------------------------- read tools

  server.registerTool(
    "wallet_balance",
    {
      title: "Wallet balance",
      description:
        "Read the agent wallet's confirmed per-currency balances from the configured node. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (): Promise<ToolResult> => {
      let loaded: LoadedPolicy;
      try {
        loaded = refreshPolicy();
      } catch (error) {
        return infraError(`The wallet policy could not be loaded: ${errorDetail(error)}`);
      }
      try {
        const balances = await reader.getBalances(loaded.policy.agentAddress);
        return ok({
          address: loaded.policy.agentAddress,
          network: loaded.policy.network,
          balances: balances.map((entry) => ({
            currency: entry.currency,
            amount: formatAmount(entry.sats),
          })),
        });
      } catch (error) {
        return infraError(`The node could not be queried for balances: ${errorDetail(error)}`);
      }
    },
  );

  server.registerTool(
    "wallet_receive_address",
    {
      title: "Receive address",
      description: "The agent wallet's own address for receiving funds. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    (): ToolResult => {
      let loaded: LoadedPolicy;
      try {
        loaded = refreshPolicy();
      } catch (error) {
        return infraError(`The wallet policy could not be loaded: ${errorDetail(error)}`);
      }
      return ok({
        address: loaded.policy.agentAddress,
        addressMode: loaded.policy.addressMode,
        network: loaded.policy.network,
      });
    },
  );

  server.registerTool(
    "wallet_list_recipients",
    {
      title: "Allowlisted recipients",
      description:
        "The operator-configured allowlists and per-currency caps: facilitators (topup " +
        "targets, may auto-approve within budget) and recipients (sends, always human-" +
        "confirmed). Only these NAMES are valid destinations. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    (): ToolResult => {
      let loaded: LoadedPolicy;
      try {
        loaded = refreshPolicy();
      } catch (error) {
        return infraError(`The wallet policy could not be loaded: ${errorDetail(error)}`);
      }
      const policy = loaded.policy;
      return ok({
        network: policy.network,
        currencies: policy.currencies.map((entry) => ({
          currency: entry.currency,
          maxPerTx: formatAmount(entry.maxPerTxSats),
          maxPerDay: formatAmount(entry.maxPerDaySats),
          maxTotal: formatAmount(entry.maxTotalSats),
        })),
        facilitators: policy.facilitators.map((entry) => ({
          name: entry.name,
          address: entry.address,
          currency: entry.currency,
          maxPerTx: formatAmount(entry.maxPerTxSats),
          maxPerDay: formatAmount(entry.maxPerDaySats),
          autoApprove: entry.autoApprove,
        })),
        recipients: policy.recipients.map((entry) => ({
          name: entry.name,
          address: entry.address,
        })),
        note: "A currency without a cap entry is not spendable. Sends always require human confirmation.",
      });
    },
  );

  server.registerTool(
    "wallet_transaction_status",
    {
      title: "Transaction status",
      description:
        "The recorded state of a prior spend by its requestId, refreshing the confirmation " +
        "count from the node when a txid exists. Read-only against the wallet.",
      inputSchema: {
        requestId: requestIdSchema.describe("The requestId the spend was submitted with."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ requestId }): Promise<ToolResult> => {
      let snapshot = ledger.getOutcome(requestId);
      if (snapshot === null) {
        return ok({
          status: "unknown-request",
          requestId,
          reason: "No spend with this requestId was ever attempted on this wallet.",
        });
      }
      let nodeNote: string | null = null;
      const txid = snapshot.txid;
      if (txid !== null && (snapshot.state === "broadcast" || snapshot.state === "confirmed")) {
        try {
          const confirmations = await reader.getConfirmations(txid);
          if (confirmations !== null && confirmations > (snapshot.confirmations ?? 0)) {
            ledger.recordConfirmed(requestId, txid, confirmations);
            snapshot = ledger.getOutcome(requestId) ?? snapshot;
          }
        } catch (error) {
          nodeNote = `Confirmation lookup failed; showing the last recorded state: ${errorDetail(error)}`;
        }
      }
      const payload = snapshotPayload(snapshot);
      return ok(nodeNote === null ? payload : { ...payload, nodeNote });
    },
  );

  // ----------------------------------------------------------------- precheck

  server.registerTool(
    "wallet_precheck",
    {
      title: "Precheck a spend (dry run)",
      description:
        "Evaluate a would-be spend against the current policy WITHOUT executing, reserving " +
        "or counting anything. Returns allow / needs-confirmation / deny with the reason. " +
        "Read-only.",
      inputSchema: {
        kind: z
          .enum(["topup", "send"])
          .describe("Which money tool would be called: topup (facilitator) or send (recipient)."),
        ...spendInputShape,
      },
      annotations: { readOnlyHint: true },
    },
    ({ kind, ...input }): ToolResult => {
      let loaded: LoadedPolicy;
      let state;
      try {
        loaded = refreshPolicy();
        state = readState(stateDir);
      } catch (error) {
        return ok({
          verdict: "deny",
          reasonCode: "policy-unreadable",
          reason: `The policy or wallet state could not be loaded: ${errorDetail(error)}`,
        });
      }
      const address = resolveRecipient(kind, input.recipient, loaded.policy);
      if (address === null) {
        const denied = notListedPayload(kind, input);
        return ok({ verdict: "deny", reasonCode: denied["reasonCode"], reason: denied["reason"] });
      }
      const decision = evaluatePolicy(
        buildIntent(kind, input, address),
        loaded.policy,
        ledger,
        state,
        clock(),
      );
      switch (decision.verdict) {
        case "auto":
          return ok({
            verdict: "allow",
            note: "This spend would execute without a confirmation prompt.",
          });
        case "confirm":
          return ok({
            verdict: "needs-confirmation",
            reason: decision.reason,
            note: "This spend would require the human to approve an elicitation prompt.",
          });
        case "deny":
          return ok({
            verdict: "deny",
            reasonCode: decision.reasonCode,
            reason: decision.humanText,
          });
      }
    },
  );

  // -------------------------------------------------------------- money tools

  server.registerTool(
    "wallet_topup_facilitator",
    {
      title: "Top up a facilitator balance",
      description:
        "Fund a v402 balance at an ALLOWLISTED facilitator (by name). Small topups within " +
        "the facilitator's budget may auto-approve; everything else asks the human. Moves " +
        "real funds.",
      inputSchema: spendInputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input): Promise<ToolResult> => executeMoney("topup", input),
  );

  server.registerTool(
    "wallet_send",
    {
      title: "Send to a recipient",
      description:
        "Send funds to an ALLOWLISTED recipient (by name). Always requires the human to " +
        "approve an elicitation prompt. Moves real funds.",
      inputSchema: spendInputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input): Promise<ToolResult> => executeMoney("send", input),
  );

  return server;
}
