/**
 * The MCP surface — the ONLY thing the LLM can touch (DESIGN.md §7).
 *
 * Eleven tools, split by trust:
 *
 * - read-only, no gate: `wallet_balance`, `wallet_receive_address`,
 *   `wallet_list_recipients`, `wallet_transaction_status`;
 * - read-only dry-run: `wallet_precheck` — runs the pure engine only,
 *   NEVER reserves, never takes the gate mutex;
 * - money, full gate sequence: `wallet_topup_facilitator`, `wallet_send`
 *   (on-chain, WalletGate) and `wallet_paid_fetch` (off-chain v402
 *   payment against prepaid credit, PaymentGate).
 *
 * Boundary rules enforced here: the agent names a recipient or service, it
 * never supplies an address or URL — resolution happens against the
 * CURRENT policy and the gate re-validates the resolved pair. Every tool
 * output is JSON-safe (bigint-free): amounts leave as 8-decimal strings
 * via `formatAmount`. Policy denials and failed spends are RESULTS, not
 * protocol errors — the agent is supposed to read and reason about them;
 * `isError` is reserved for infrastructure failures (unreadable policy,
 * unreachable node).
 *
 * `ElicitationConfirmer` is the production `Confirmer`: MCP form-mode
 * elicitation with an explicit {approve, deny} enum and NO default (a
 * pre-filled answer invites rubber-stamping). No form capability ⇒
 * unavailable ⇒ the gate fails closed. Decline, cancel, timeout and
 * malformed answers all read as refusal.
 */

import { V402Client } from "@chainvue/v402-client-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { formatAmount, parseAmount } from "@chainvue/verus-rpc";
import { z } from "zod";

import { errorDetail } from "./errors.js";

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
import { SpendLock } from "./lock.js";
import { buildIdentitySigner, V402PaymentBackend, type PaymentBackend } from "./payment.js";
import { PaymentGate, type PaidFetchOutcome } from "./payment-gate.js";
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
  /**
   * Payment backend override for tests; production default is the
   * {@link V402PaymentBackend} over the global fetch and the keystore.
   */
  paymentBackend?: PaymentBackend;
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
    httpStatus: snapshot.httpStatus,
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
        "change. Recipients, facilitators and paid services are named allowlist entries " +
        "(wallet_list_recipients); amounts are decimal strings. Use wallet_precheck to " +
        "test an on-chain intent before spending. Denials are final — do not retry a " +
        "denied intent with varied parameters. Orientation: wallet_financial_position is " +
        "the cockpit (balances, budgets, in-flight, runway); wallet_spending_report " +
        "answers what was spent (chartable); wallet_prepaid_balance reads your credit at " +
        "a facilitator. Three money pools: ON-CHAIN wallet balance (wallet_topup_" +
        "facilitator/wallet_send move it), PREPAID credit at facilitators (funded by " +
        "topups), and wallet_paid_fetch BURNS that prepaid credit per API call — one " +
        "identity, one key, one policy, one ledger for all of it.",
    },
  );

  const confirmer = deps.confirmer ?? new ElicitationConfirmer(server);
  // One lock shared by both money gates: at most one on-chain spend OR paid
  // fetch — hence at most one pending human elicitation — in flight at a time.
  const spendLock = new SpendLock();
  const gate = new WalletGate({
    policySource,
    ledger,
    backend: deps.backend,
    confirmer,
    audit,
    stateDir,
    clock,
    lock: spendLock,
  });
  const paymentGate = new PaymentGate({
    policySource,
    ledger,
    backend:
      deps.paymentBackend ??
      new V402PaymentBackend({ reader, stateDir, clock }),
    confirmer,
    audit,
    stateDir,
    clock,
    lock: spendLock,
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

  /**
   * Best-effort friendly name for an i-address (UX-GAPS #10). Display aid
   * ONLY — names come from the untrusted node and never feed decisions.
   */
  async function friendlyName(address: string): Promise<string | null> {
    try {
      return await reader.getFriendlyName(address);
    } catch {
      return null;
    }
  }

  server.registerTool(
    "wallet_balance",
    {
      title: "Wallet balance",
      description:
        "Read the agent wallet's confirmed per-currency balances from the configured node. " +
        "This is the ON-CHAIN wallet balance — PREPAID credit held at facilitators is " +
        "separate (wallet_prepaid_balance). Read-only.",
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
        const name = await friendlyName(loaded.policy.agentAddress);
        return ok({
          address: loaded.policy.agentAddress,
          ...(name !== null ? { identityName: name } : {}),
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
      description:
        "The agent wallet's own address for receiving funds — in identity mode both the " +
        "i-address and its human-readable VerusID name (they are the SAME identity). Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> => {
      let loaded: LoadedPolicy;
      try {
        loaded = refreshPolicy();
      } catch (error) {
        return infraError(`The wallet policy could not be loaded: ${errorDetail(error)}`);
      }
      const name = await friendlyName(loaded.policy.agentAddress);
      return ok({
        address: loaded.policy.agentAddress,
        ...(name !== null ? { identityName: name } : {}),
        addressMode: loaded.policy.addressMode,
        network: loaded.policy.network,
        ...(name !== null
          ? { note: `${name} and ${loaded.policy.agentAddress} are the same identity — either receives.` }
          : {}),
      });
    },
  );

  server.registerTool(
    "wallet_list_recipients",
    {
      title: "Allowlisted recipients",
      description:
        "The operator-configured allowlists — the agent's ENTIRE payment universe. Three " +
        "categories with different trust models: FACILITATORS are prepaid v402 banks " +
        "(wallet_topup_facilitator deposits credit there; small topups within the shown " +
        "budget auto-approve because the operator pre-authorized that budget) — " +
        "RECIPIENTS are arbitrary payout destinations (wallet_send, ALWAYS " +
        "human-confirmed, because arbitrary sends are how money leaves for good) — " +
        "SERVICES are v402-guarded APIs payable per call with wallet_paid_fetch, burning " +
        "prepaid credit at the linked facilitator within the shown per-call/daily caps. " +
        "remainingToday shows what is left of each trailing-24h budget right now. Only " +
        "these NAMES are valid destinations. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> => {
      let loaded: LoadedPolicy;
      try {
        loaded = refreshPolicy();
      } catch (error) {
        return infraError(`The wallet policy could not be loaded: ${errorDetail(error)}`);
      }
      const policy = loaded.policy;
      const now = clock();
      const dayMs = 24 * 60 * 60 * 1000;
      const facilitators = [];
      for (const entry of policy.facilitators) {
        const spentToday = ledger.facilitatorSpentInWindowSats(
          entry.address,
          entry.currency,
          dayMs,
          now,
        );
        const remaining = entry.maxPerDaySats - spentToday;
        facilitators.push({
          name: entry.name,
          address: entry.address,
          ...(await friendlyName(entry.address).then((n) =>
            n !== null ? { identityName: n } : {},
          )),
          currency: entry.currency,
          maxPerTx: formatAmount(entry.maxPerTxSats),
          maxPerDay: formatAmount(entry.maxPerDaySats),
          remainingToday: formatAmount(remaining > 0n ? remaining : 0n),
          autoApprove: entry.autoApprove,
          ...(entry.apiUrl !== undefined ? { apiUrl: entry.apiUrl } : {}),
        });
      }
      const recipients = [];
      for (const entry of policy.recipients) {
        recipients.push({
          name: entry.name,
          address: entry.address,
          ...(await friendlyName(entry.address).then((n) =>
            n !== null ? { identityName: n } : {},
          )),
        });
      }
      const services = policy.services.map((entry) => {
        const spentToday = ledger.serviceSpentInWindowSats(
          entry.origin,
          entry.currency,
          dayMs,
          now,
        );
        const remaining = entry.maxPerDaySats - spentToday;
        return {
          name: entry.name,
          origin: entry.origin,
          facilitator: entry.facilitator,
          currency: entry.currency,
          maxPricePerCall: formatAmount(entry.maxPricePerCallSats),
          maxPerDay: formatAmount(entry.maxPerDaySats),
          remainingToday: formatAmount(remaining > 0n ? remaining : 0n),
          autoApprove: entry.autoApprove,
        };
      });
      return ok({
        network: policy.network,
        currencies: policy.currencies.map((entry) => ({
          currency: entry.currency,
          maxPerTx: formatAmount(entry.maxPerTxSats),
          maxPerDay: formatAmount(entry.maxPerDaySats),
          maxTotal: formatAmount(entry.maxTotalSats),
        })),
        facilitators,
        recipients,
        services,
        note:
          "A currency without a cap entry is not spendable. Sends always require human " +
          "confirmation; only the operator (CLI) can add or change entries.",
      });
    },
  );

  server.registerTool(
    "wallet_transaction_status",
    {
      title: "Transaction status",
      description:
        "The recorded state of a prior spend, looked up by requestId OR by txid, refreshing " +
        "the confirmation count from the node when a txid exists. Flags spends that have " +
        "been pending unusually long. Read-only against the wallet.",
      inputSchema: {
        requestId: requestIdSchema
          .optional()
          .describe("The requestId the spend was submitted with (preferred lookup key)."),
        txid: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional()
          .describe("Alternative lookup: the broadcast transaction id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ requestId, txid: txidInput }): Promise<ToolResult> => {
      let snapshot =
        requestId !== undefined
          ? ledger.getOutcome(requestId)
          : txidInput !== undefined
            ? (ledger.allSnapshots().find((s) => s.txid === txidInput) ?? null)
            : null;
      if (requestId === undefined && txidInput === undefined) {
        return ok({
          status: "invalid-input",
          reason: "Provide a requestId or a txid to look up.",
        });
      }
      if (snapshot === null) {
        return ok({
          status: "unknown-request",
          ...(requestId !== undefined ? { requestId } : { txid: txidInput }),
          reason: "No spend matching this key was ever attempted on this wallet.",
        });
      }
      let nodeNote: string | null = null;
      const txid = snapshot.txid;
      if (txid !== null && (snapshot.state === "broadcast" || snapshot.state === "confirmed")) {
        try {
          const confirmations = await reader.getConfirmations(txid);
          if (confirmations !== null && confirmations > (snapshot.confirmations ?? 0)) {
            ledger.recordConfirmed(snapshot.requestId, txid, confirmations);
            snapshot = ledger.getOutcome(snapshot.requestId) ?? snapshot;
          }
        } catch (error) {
          nodeNote = `Confirmation lookup failed; showing the last recorded state: ${errorDetail(error)}`;
        }
      }
      const payload = snapshotPayload(snapshot);
      // In-flight staleness (UX-GAPS #2/#11): an unconfirmed broadcast older
      // than ~3 average block times deserves a flag, not silence.
      if (snapshot.state === "broadcast" && (snapshot.confirmations ?? 0) === 0) {
        const ageMinutes = Math.floor(
          (clock().getTime() - new Date(snapshot.pendingAt).getTime()) / 60_000,
        );
        if (ageMinutes >= 5) {
          payload["staleness"] =
            `Unconfirmed for ${ageMinutes} min (typical: ~1-2 min per confirmation on ` +
            `VRSCTEST). Testnet block gaps happen; if this persists for hours, the ` +
            `operator can settle it with \`peculium resolve\`.`;
        }
      }
      // Facilitator credit latency (UX-GAPS #2): confirmed ≠ credited.
      if (snapshot.kind === "topup" && snapshot.state !== "failed") {
        payload["creditNote"] =
          "Facilitators credit deposits after their confirmation depth (commonly ~10 " +
          "confirmations, ~10 min) — a confirmed tx may take a few more minutes to appear " +
          "in the prepaid balance.";
      }
      return ok(nodeNote === null ? payload : { ...payload, nodeNote });
    },
  );

  // ------------------------------------------------------------- report tools

  server.registerTool(
    "wallet_spending_report",
    {
      title: "Spending report",
      description:
        'Answers "what did I spend money on?" from the wallet\'s append-only ledger: a ' +
        "LIST of recent money requests (with their requestIds — use them with " +
        "wallet_transaction_status) plus AGGREGATES bucketed by day, recipient or kind. " +
        "Covers on-chain spends AND off-chain paid-fetch payments. Amounts counted as " +
        "spent follow the same fail-closed rule as the caps (broadcast/confirmed/" +
        "settled/pending/ambiguous count; definite failures do not). " +
        "Ideal source data for charts. Read-only, wallet-local.",
      inputSchema: {
        recipient: z
          .string()
          .min(1)
          .optional()
          .describe("Filter to one allowlist name (facilitator, recipient or paid service)."),
        kind: z
          .enum(["topup", "send", "paid-fetch"])
          .optional()
          .describe("Filter to one request kind (paid-fetch = off-chain v402 payments)."),
        sinceHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 365)
          .optional()
          .describe("Look-back window in hours (default 168 = 7 days)."),
        groupBy: z
          .enum(["day", "recipient", "kind"])
          .optional()
          .describe('Aggregation dimension (default "day").'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max entries in the recent-requests list (default 20)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ recipient, kind, sinceHours, groupBy, limit }): ToolResult => {
      const now = clock();
      const windowMs = (sinceHours ?? 168) * 60 * 60 * 1000;
      const sinceMs = now.getTime() - windowMs;
      const rows = ledger
        .allSnapshots()
        .filter((s) => new Date(s.pendingAt).getTime() >= sinceMs)
        .filter((s) => (recipient === undefined ? true : s.recipientName === recipient))
        .filter((s) => (kind === undefined ? true : s.kind === kind))
        .sort((a, b) => (a.pendingAt < b.pendingAt ? 1 : -1));

      const bucketKey = (s: RequestSnapshot): string => {
        switch (groupBy ?? "day") {
          case "day":
            return s.pendingAt.slice(0, 10);
          case "recipient":
            return s.recipientName;
          case "kind":
            return s.kind;
        }
      };
      interface Bucket {
        bucket: string;
        currency: string;
        spentSats: bigint;
        txCount: number;
        failedCount: number;
        pendingCount: number;
      }
      const buckets = new Map<string, Bucket>();
      for (const s of rows) {
        const key = `${bucketKey(s)}|${s.currency}`;
        const bucket =
          buckets.get(key) ??
          ({
            bucket: bucketKey(s),
            currency: s.currency,
            spentSats: 0n,
            txCount: 0,
            failedCount: 0,
            pendingCount: 0,
          } satisfies Bucket);
        if (s.countsAsSpent) {
          bucket.spentSats += s.amountSats;
          bucket.txCount += 1;
        } else {
          bucket.failedCount += 1;
        }
        if (s.state === "broadcast" || s.state === "pending" || s.state === "ambiguous") {
          bucket.pendingCount += 1;
        }
        buckets.set(key, bucket);
      }

      let totalSpentSats = 0n;
      for (const s of rows) {
        if (s.countsAsSpent) {
          totalSpentSats += s.amountSats;
        }
      }

      return ok({
        since: new Date(sinceMs).toISOString(),
        until: now.toISOString(),
        filter: {
          ...(recipient !== undefined ? { recipient } : {}),
          ...(kind !== undefined ? { kind } : {}),
        },
        groupBy: groupBy ?? "day",
        totalRequests: rows.length,
        totalSpent: formatAmount(totalSpentSats),
        buckets: [...buckets.values()]
          .sort((a, b) => a.bucket.localeCompare(b.bucket))
          .map((b) => ({
            bucket: b.bucket,
            currency: b.currency,
            spent: formatAmount(b.spentSats),
            txCount: b.txCount,
            failedCount: b.failedCount,
            pendingCount: b.pendingCount,
          })),
        recent: rows.slice(0, limit ?? 20).map((s) => ({
          requestId: s.requestId,
          at: s.pendingAt,
          kind: s.kind,
          recipient: s.recipientName,
          amount: formatAmount(s.amountSats),
          currency: s.currency,
          state: s.state,
          approval: s.approval,
          txid: s.txid,
          ...(s.httpStatus !== null ? { httpStatus: s.httpStatus } : {}),
        })),
      });
    },
  );

  server.registerTool(
    "wallet_financial_position",
    {
      title: "Financial position (cockpit)",
      description:
        "The whole money picture in one call: on-chain wallet balance, today's spend vs " +
        "every cap, per-facilitator remaining budgets, per-service remaining paid-fetch " +
        "budgets, in-flight/ambiguous requests, and a burn-rate → runway estimate from " +
        "the trailing 7 days. PREPAID credit at facilitators is separate " +
        "(wallet_prepaid_balance — it requires a signed query). Read-only.",
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
      const policy = loaded.policy;
      const now = clock();
      const dayMs = 24 * 60 * 60 * 1000;

      let balances: { currency: string; amount: string }[] = [];
      let balanceNote: string | null = null;
      try {
        const raw = await reader.getBalances(policy.agentAddress);
        balances = raw.map((entry) => ({
          currency: entry.currency,
          amount: formatAmount(entry.sats),
        }));
      } catch (error) {
        balanceNote = `Balance lookup failed: ${errorDetail(error)}`;
      }

      const caps = policy.currencies.map((entry) => {
        const spentToday = ledger.spentInWindowSats(entry.currency, dayMs, now);
        const spentTotal = ledger.totalSpentSats(entry.currency);
        return {
          currency: entry.currency,
          spentToday: formatAmount(spentToday),
          maxPerDay: formatAmount(entry.maxPerDaySats),
          remainingToday: formatAmount(
            entry.maxPerDaySats > spentToday ? entry.maxPerDaySats - spentToday : 0n,
          ),
          spentTotal: formatAmount(spentTotal),
          maxTotal: formatAmount(entry.maxTotalSats),
        };
      });

      const facilitators = policy.facilitators.map((entry) => {
        const spentToday = ledger.facilitatorSpentInWindowSats(
          entry.address,
          entry.currency,
          dayMs,
          now,
        );
        const remaining = entry.maxPerDaySats - spentToday;
        return {
          name: entry.name,
          currency: entry.currency,
          remainingToday: formatAmount(remaining > 0n ? remaining : 0n),
          autoApprove: entry.autoApprove,
          ...(entry.apiUrl !== undefined ? { apiUrl: entry.apiUrl } : {}),
        };
      });

      const services = policy.services.map((entry) => {
        const spentToday = ledger.serviceSpentInWindowSats(
          entry.origin,
          entry.currency,
          dayMs,
          now,
        );
        const remaining = entry.maxPerDaySats - spentToday;
        return {
          name: entry.name,
          currency: entry.currency,
          spentToday: formatAmount(spentToday),
          remainingToday: formatAmount(remaining > 0n ? remaining : 0n),
          autoApprove: entry.autoApprove,
        };
      });

      const inFlight = ledger
        .allSnapshots()
        .filter((s) => s.state === "pending" || s.state === "broadcast" || s.state === "ambiguous")
        .map((s) => ({
          requestId: s.requestId,
          kind: s.kind,
          state: s.state,
          amount: formatAmount(s.amountSats),
          currency: s.currency,
          recipient: s.recipientName,
          at: s.pendingAt,
        }));

      // Burn rate over the trailing 7 days → runway of the NATIVE balance.
      const native = policy.currencies[0]?.currency ?? policy.network;
      const spent7d = ledger.spentInWindowSats(native, 7 * dayMs, now);
      const burnPerDaySats = spent7d / 7n;
      const nativeBalance = balances.find((b) => b.currency === native);
      let runway: string | null = null;
      if (burnPerDaySats > 0n && nativeBalance !== undefined) {
        const balanceSats = parseAmount(nativeBalance.amount);
        runway = `${(Number(balanceSats) / Number(burnPerDaySats)).toFixed(1)} days at the current burn rate`;
      }

      return ok({
        address: policy.agentAddress,
        network: policy.network,
        balances,
        ...(balanceNote !== null ? { balanceNote } : {}),
        caps,
        facilitators,
        services,
        inFlight,
        burn: {
          window: "7d",
          currency: native,
          spent: formatAmount(spent7d),
          perDay: formatAmount(burnPerDaySats),
          ...(runway !== null ? { runway } : {}),
        },
      });
    },
  );

  server.registerTool(
    "wallet_prepaid_balance",
    {
      title: "Prepaid balance at a facilitator",
      description:
        "The agent's PREPAID credit at an allowlisted facilitator (its v402 'bank' " +
        "account) — balance, reserved and available, plus pending deposits where the " +
        "facilitator reports them. This is credit ALREADY DEPOSITED there via " +
        "wallet_topup_facilitator; it is not the on-chain wallet balance. The query is " +
        "signed with the wallet identity's key (only the identity owner can read its " +
        "account). Requires identity mode and an operator-configured apiUrl for the " +
        "facilitator. Read-only.",
      inputSchema: {
        facilitator: z
          .string()
          .min(1)
          .describe("Allowlist NAME of the facilitator (see wallet_list_recipients)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ facilitator }): Promise<ToolResult> => {
      let loaded: LoadedPolicy;
      try {
        loaded = refreshPolicy();
      } catch (error) {
        return infraError(`The wallet policy could not be loaded: ${errorDetail(error)}`);
      }
      const policy = loaded.policy;
      const entry = policy.facilitators.find((candidate) => candidate.name === facilitator);
      if (entry === undefined) {
        return ok({
          status: "unknown-facilitator",
          facilitator,
          reason:
            `"${facilitator}" is not on the facilitator allowlist. ` +
            `Call wallet_list_recipients for the configured names.`,
        });
      }
      if (entry.apiUrl === undefined) {
        return ok({
          status: "no-api-url",
          facilitator,
          reason:
            `The operator has not recorded an API URL for "${facilitator}" — the balance ` +
            `cannot be queried. Operator fix: peculium allow facilitator … --api-url <https://…> ` +
            `(or edit the policy entry).`,
        });
      }
      if (!policy.agentAddress.startsWith("i")) {
        return ok({
          status: "identity-required",
          facilitator,
          reason:
            "Facilitator accounts are keyed by VerusID; this wallet runs in starter " +
            "(R-address) mode, which has no facilitator-readable account. See " +
            "docs/IDENTITY-RUNBOOK.md for the identity upgrade.",
        });
      }
      const payer = await friendlyName(policy.agentAddress);
      if (payer === null) {
        return infraError(
          `The agent identity's name could not be resolved from the node — cannot build ` +
            `the signed balance query.`,
        );
      }
      const passphrase = process.env["PECULIUM_KEYSTORE_PASSPHRASE"];
      if (passphrase === undefined || passphrase === "") {
        return ok({
          status: "keystore-locked",
          facilitator,
          reason:
            "PECULIUM_KEYSTORE_PASSPHRASE is not set — the balance query must be signed " +
            "with the wallet identity's key. Configure the passphrase in the MCP host env.",
        });
      }
      try {
        const signer = buildIdentitySigner({
          reader,
          stateDir,
          agentAddress: policy.agentAddress,
          network: policy.network,
          passphrase,
        });
        const client = new V402Client({
          identity: payer,
          signer,
          facilitator: entry.apiUrl,
        });
        const balance = await client.getBalance();
        // `pending` is the Package-B facilitator extension — surface it when
        // present without requiring the newer facilitator.
        const extra = balance as unknown as Record<string, unknown>;
        return ok({
          facilitator,
          apiUrl: entry.apiUrl,
          identity: payer,
          balance: balance.balance,
          reserved: balance.reserved,
          available: balance.available,
          ...(typeof extra["pending"] === "string" ? { pending: extra["pending"] } : {}),
          note:
            "Deposits credit after the facilitator's confirmation depth — a recent topup " +
            "may not be reflected yet (wallet_transaction_status shows its confirmations).",
        });
      } catch (error) {
        return infraError(
          `The prepaid balance could not be read from ${entry.apiUrl}: ${errorDetail(error)}`,
        );
      }
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

  /** JSON-safe view of a payment-gate outcome. */
  function paidFetchPayload(outcome: PaidFetchOutcome): ToolPayload {
    switch (outcome.status) {
      case "settled":
        return {
          status: "settled",
          requestId: outcome.requestId,
          service: outcome.service,
          amountPaid: formatAmount(outcome.amountSats),
          currency: outcome.currency,
          httpStatus: outcome.response.httpStatus,
          contentType: outcome.response.contentType,
          body: outcome.response.body,
          bodyEncoding: outcome.response.bodyEncoding,
          ...(outcome.response.truncated ? { truncated: true } : {}),
          ...(outcome.response.httpStatus >= 200 && outcome.response.httpStatus < 300
            ? {}
            : {
                note:
                  "The payment was sent but the endpoint answered non-2xx; the amount " +
                  "counts as spent (fail closed — the facilitator may have rolled it " +
                  "back, which wallet_prepaid_balance would show).",
              }),
        };
      case "no-payment-required":
        return {
          status: "no-payment-required",
          requestId: outcome.requestId,
          service: outcome.service,
          httpStatus: outcome.response.httpStatus,
          contentType: outcome.response.contentType,
          body: outcome.response.body,
          bodyEncoding: outcome.response.bodyEncoding,
          ...(outcome.response.truncated ? { truncated: true } : {}),
          note: "The endpoint answered without demanding payment — nothing was paid or recorded.",
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
          note:
            "This requestId was already processed; this is the recorded outcome, no new " +
            "payment happened. Response bodies are not stored — use a fresh requestId to " +
            "call the service again.",
          priorOutcome: snapshotPayload(outcome.snapshot),
        };
    }
  }

  server.registerTool(
    "wallet_paid_fetch",
    {
      title: "Pay a v402 API call from prepaid credit",
      description:
        "Call an ALLOWLISTED paid service (by name) and pay its v402 price per request " +
        "from the PREPAID credit at the service's linked facilitator — an OFF-CHAIN " +
        "signature, not a blockchain transaction. The wallet preflights the endpoint, " +
        "reads the 402 price offer, and only pays if the price is within the service's " +
        "per-call cap AND its remaining daily budget (wallet_list_recipients shows both); " +
        "within budget it runs unattended. Over-budget offers are DENIED, never paid. " +
        "The response body is returned along with the amount paid. If prepaid credit is " +
        "insufficient, top up first (wallet_prepaid_balance shows credit, " +
        "wallet_topup_facilitator funds it). Denials are final for the same parameters; " +
        "a 'failed' outcome paid nothing and may be retried with a FRESH requestId.",
      inputSchema: {
        requestId: requestIdSchema.describe(
          "Caller-chosen idempotency key (8-64 chars of [A-Za-z0-9._-]). A known " +
            "requestId never pays twice; it replays the recorded outcome WITHOUT the " +
            "response body — use a fresh id per distinct call.",
        ),
        service: z
          .string()
          .min(1)
          .describe(
            "Allowlist NAME of the paid service (see wallet_list_recipients) — never a URL.",
          ),
        path: z
          .string()
          .max(2048)
          .regex(/^\/[\x21-\x7e]*$/, "must start with '/' and contain printable ASCII only")
          .optional()
          .describe('Request path + query on the service, e.g. "/v1/search?q=verus". Default "/".'),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .optional()
          .describe('HTTP method (default "GET").'),
        body: z
          .string()
          .max(1024 * 1024)
          .optional()
          .describe("Request body for POST/PUT/PATCH (its hash is bound into the payment)."),
        maxPrice: amountStringSchema
          .optional()
          .describe(
            "Optional own price ceiling for THIS call (decimal string). The offer is " +
              "denied if it asks more — tighter than, never instead of, the operator's caps.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ requestId, service, path, method, body, maxPrice }): Promise<ToolResult> => {
      // All preconditions — replay, policy load, arm window, identity mode,
      // keystore readiness — live INSIDE the gate so replay (which needs no
      // key) always wins: a locked keystore never hides an already-recorded
      // outcome (the idempotency contract), and no check runs before the
      // network preflight that the gate does not also enforce.
      const outcome = await paymentGate.execute({
        requestId,
        service,
        path: path ?? "/",
        method: method ?? "GET",
        ...(body !== undefined ? { body } : {}),
        ...(maxPrice !== undefined ? { maxPriceSats: parseAmount(maxPrice) } : {}),
      });
      return ok(paidFetchPayload(outcome));
    },
  );

  return server;
}
