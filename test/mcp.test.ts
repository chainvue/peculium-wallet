// InMemory end-to-end tests of the MCP surface: a real SDK Client talks to
// the real server over a linked transport pair, with and without the
// elicitation capability (the E4 honest gate). The money path runs the real
// gate, ledger and audit against a scripted MockBackend/MockReader.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { parseAmount } from "@chainvue/verus-rpc";
import { afterEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit.js";
import { MockBackend, UnavailableBackend, type WalletBackend } from "../src/backend.js";
import { SpendLedger } from "../src/ledger/ledger.js";
import { buildMcpServer, ElicitationConfirmer } from "../src/mcp.js";
import { MockPaymentBackend } from "../src/payment.js";
import { PolicySource } from "../src/policy/load.js";
import { MockReader } from "../src/reader.js";
import { policyFile, policyFileWithService } from "./helpers.js";
import type { PolicyFileInput } from "../src/policy/schema.js";

type ElicitBehavior =
  | "approve"
  | "deny-decision"
  | "decline"
  | "hang"
  | ((message: string) => ElicitResult);

interface HarnessOptions {
  policy?: Partial<PolicyFileInput>;
  backend?: WalletBackend;
  /** undefined = client WITHOUT the elicitation capability. */
  elicit?: ElicitBehavior;
}

interface Harness {
  client: Client;
  server: McpServer;
  ledger: SpendLedger;
  backend: MockBackend;
  paymentBackend: MockPaymentBackend;
  reader: MockReader;
  dir: string;
  /** Every elicitation message the client received, in order. */
  elicitations: string[];
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-mcp-"));
  fs.writeFileSync(
    path.join(dir, "policy.json"),
    JSON.stringify(policyFile(opts.policy ?? {}), null, 2),
    { mode: 0o600 },
  );
  const ledger = SpendLedger.open(dir);
  const audit = AuditLog.open(dir);
  const backend = new MockBackend();
  const paymentBackend = new MockPaymentBackend();
  const reader = new MockReader();

  const server = buildMcpServer({
    policySource: new PolicySource(dir),
    ledger,
    backend: opts.backend ?? backend,
    paymentBackend,
    reader,
    audit,
    stateDir: dir,
    version: "0.0.0-test",
  });

  const elicitations: string[] = [];
  const client =
    opts.elicit === undefined
      ? new Client({ name: "test-client", version: "0" })
      : new Client(
          { name: "test-client", version: "0" },
          { capabilities: { elicitation: { form: {} } } },
        );
  if (opts.elicit !== undefined) {
    const behavior = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
      const message = request.params.message;
      elicitations.push(message);
      if (behavior === "hang") {
        return new Promise<ElicitResult>(() => undefined);
      }
      if (behavior === "approve") {
        return { action: "accept", content: { decision: "approve" } };
      }
      if (behavior === "deny-decision") {
        return { action: "accept", content: { decision: "deny" } };
      }
      if (behavior === "decline") {
        return { action: "decline" };
      }
      return behavior(message);
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  cleanups.push(async () => {
    await client.close();
    await server.close();
    audit.close();
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { client, server, ledger, backend, paymentBackend, reader, dir, elicitations };
}

/** Call a tool and return its structured payload (asserting it is JSON-safe). */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  if (result.isError === true) {
    throw new Error(`tool "${name}" errored: ${result.content[0]?.text ?? "(no text)"}`);
  }
  const payload = result.structuredContent;
  expect(payload).toBeDefined();
  // The E4 gate: outputs must be bigint-free / JSON-round-trippable.
  expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  return payload as Record<string, unknown>;
}

// The ledger enforces real wire shapes: 64-hex txids, "txid:vout" outpoints.
const TXID = "ab".repeat(32);
const PREV_TXID = "cd".repeat(32);
const RECEIPT = {
  txid: TXID,
  spentOutpoints: [`${PREV_TXID}:0`],
  changeOutpoint: `${TXID}:1`,
};

describe("tool surface", () => {
  it("exposes exactly the eleven v1 tools", async () => {
    const { client } = await makeHarness();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "wallet_balance",
      "wallet_financial_position",
      "wallet_list_recipients",
      "wallet_paid_fetch",
      "wallet_precheck",
      "wallet_prepaid_balance",
      "wallet_receive_address",
      "wallet_send",
      "wallet_spending_report",
      "wallet_topup_facilitator",
      "wallet_transaction_status",
    ]);
  });
});

describe("read tools", () => {
  it("wallet_balance reports per-currency decimal amounts", async () => {
    const { client, reader } = await makeHarness();
    reader.balances = [
      { currency: "VRSCTEST", sats: 150000000n },
      { currency: "TOKEN", sats: 1n },
    ];
    const payload = await call(client, "wallet_balance");
    expect(payload).toEqual({
      address: "RAgent1111111111111111111111111111",
      network: "VRSCTEST",
      balances: [
        { currency: "VRSCTEST", amount: "1.50000000" },
        { currency: "TOKEN", amount: "0.00000001" },
      ],
    });
  });

  it("wallet_balance surfaces node failures as tool errors", async () => {
    const { client, reader } = await makeHarness();
    reader.failWith = new Error("gateway unreachable");
    const result = (await client.callTool({ name: "wallet_balance", arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("gateway unreachable");
  });

  it("wallet_receive_address returns the policy address", async () => {
    const { client } = await makeHarness();
    expect(await call(client, "wallet_receive_address")).toEqual({
      address: "RAgent1111111111111111111111111111",
      addressMode: "verusid",
      network: "VRSCTEST",
    });
  });

  it("wallet_list_recipients reports allowlists and per-currency caps", async () => {
    const { client } = await makeHarness();
    const payload = await call(client, "wallet_list_recipients");
    expect(payload["currencies"]).toEqual([
      {
        currency: "VRSCTEST",
        maxPerTx: "2.00000000",
        maxPerDay: "8.00000000",
        maxTotal: "20.00000000",
      },
      {
        currency: "TOKEN",
        maxPerTx: "100.00000000",
        maxPerDay: "500.00000000",
        maxTotal: "1000.00000000",
      },
    ]);
    expect(payload["facilitators"]).toEqual([
      {
        name: "demo-facilitator",
        address: "RFacilitator1111111111111111111111",
        currency: "VRSCTEST",
        maxPerTx: "0.50000000",
        maxPerDay: "2.00000000",
        remainingToday: "2.00000000",
        autoApprove: true,
      },
    ]);
    expect(payload["recipients"]).toEqual([
      { name: "alice", address: "RAlice1111111111111111111111111111" },
    ]);
  });

  it("wallet_list_recipients shrinks remainingToday after a topup", async () => {
    const { client } = await makeHarness();
    await call(client, "wallet_topup_facilitator", {
      requestId: "req-remaining-1",
      amount: "0.5",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });
    const payload = await call(client, "wallet_list_recipients");
    const facilitators = payload["facilitators"] as Array<Record<string, unknown>>;
    expect(facilitators[0]?.["remainingToday"]).toBe("1.50000000");
  });
});

describe("wallet_precheck", () => {
  const input = {
    requestId: "req-precheck-1",
    amount: "0.1",
    currency: "VRSCTEST",
    recipient: "demo-facilitator",
  };

  it("returns allow for an in-budget auto topup — and never reserves", async () => {
    const { client, ledger, backend } = await makeHarness();
    const payload = await call(client, "wallet_precheck", { kind: "topup", ...input });
    expect(payload["verdict"]).toBe("allow");
    // Nothing ledgered, nothing executed, no idempotency claimed:
    expect(ledger.getOutcome(input.requestId)).toBeNull();
    expect(ledger.totalSpentSats("VRSCTEST")).toBe(0n);
    expect(backend.instructions).toHaveLength(0);
    // A repeat precheck is not a duplicate — precheck left no fingerprint.
    const again = await call(client, "wallet_precheck", { kind: "topup", ...input });
    expect(again["verdict"]).toBe("allow");
  });

  it("returns needs-confirmation for a send", async () => {
    const { client } = await makeHarness();
    const payload = await call(client, "wallet_precheck", {
      kind: "send",
      ...input,
      recipient: "alice",
    });
    expect(payload["verdict"]).toBe("needs-confirmation");
    expect(payload["reason"]).toBe("send-always-confirms");
  });

  it("returns deny with the engine's code above a cap", async () => {
    const { client } = await makeHarness();
    const payload = await call(client, "wallet_precheck", {
      kind: "send",
      ...input,
      recipient: "alice",
      amount: "3",
    });
    expect(payload["verdict"]).toBe("deny");
    expect(payload["reasonCode"]).toBe("per-tx-cap-exceeded");
  });

  it("denies an unlisted name without touching the gate", async () => {
    const { client, backend } = await makeHarness();
    const payload = await call(client, "wallet_precheck", {
      kind: "send",
      ...input,
      recipient: "mallory",
    });
    expect(payload["verdict"]).toBe("deny");
    expect(payload["reasonCode"]).toBe("recipient-not-listed");
    expect(backend.instructions).toHaveLength(0);
  });
});

describe("wallet_topup_facilitator", () => {
  it("auto-approves an in-budget topup without eliciting", async () => {
    const { client, backend, ledger, elicitations } = await makeHarness({ elicit: "approve" });
    backend.willSucceed(RECEIPT);
    const payload = await call(client, "wallet_topup_facilitator", {
      requestId: "req-topup-auto",
      amount: "0.1",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });
    expect(payload["status"]).toBe("committed");
    expect(payload["txid"]).toBe(TXID);
    expect(elicitations).toHaveLength(0);
    expect(backend.instructions).toHaveLength(1);
    expect(backend.instructions[0]?.toAddress).toBe("RFacilitator1111111111111111111111");
    expect(ledger.getOutcome("req-topup-auto")?.approval).toBe("auto");
    expect(ledger.getOutcome("req-topup-auto")?.state).toBe("broadcast");
  });

  it("asks the human above the facilitator budget and records human-confirmed", async () => {
    const { client, backend, ledger, elicitations } = await makeHarness({ elicit: "approve" });
    backend.willSucceed(RECEIPT);
    const payload = await call(client, "wallet_topup_facilitator", {
      requestId: "req-topup-big1",
      amount: "0.75",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });
    expect(payload["status"]).toBe("committed");
    expect(elicitations).toHaveLength(1);
    expect(ledger.getOutcome("req-topup-big1")?.approval).toBe("human-confirmed");
  });

  it("reports a definitive backend rejection as failed and releases the reservation", async () => {
    const { client, backend, ledger } = await makeHarness();
    backend.willReject("broadcast-rejected", "tx-conflict", -26);
    const payload = await call(client, "wallet_topup_facilitator", {
      requestId: "req-topup-fail",
      amount: "0.1",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });
    expect(payload["status"]).toBe("failed");
    expect(payload["stage"]).toBe("broadcast-rejected");
    expect(ledger.totalSpentSats("VRSCTEST")).toBe(0n);
  });

  it("keeps an uncertain broadcast reserved as ambiguous", async () => {
    const { client, backend, ledger } = await makeHarness();
    backend.willBeUncertain("socket closed mid-send");
    const payload = await call(client, "wallet_topup_facilitator", {
      requestId: "req-topup-ambig",
      amount: "0.1",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });
    expect(payload["status"]).toBe("ambiguous");
    expect(ledger.getOutcome("req-topup-ambig")?.countsAsSpent).toBe(true);
  });

  it("fails cleanly through the UnavailableBackend (the E4 wiring)", async () => {
    const { client, ledger } = await makeHarness({ backend: new UnavailableBackend() });
    const payload = await call(client, "wallet_topup_facilitator", {
      requestId: "req-topup-unav",
      amount: "0.1",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });
    expect(payload["status"]).toBe("failed");
    expect(payload["stage"]).toBe("build");
    expect(payload["reason"]).toContain("No funds were moved");
    expect(ledger.totalSpentSats("VRSCTEST")).toBe(0n);
  });
});

describe("wallet_send with elicitation", () => {
  const input = {
    requestId: "req-send-e2e-1",
    amount: "0.25",
    currency: "VRSCTEST",
    recipient: "alice",
  };

  it("commits after the human approves; the prompt shows the validated intent", async () => {
    const { client, backend, ledger, elicitations } = await makeHarness({ elicit: "approve" });
    backend.willSucceed(RECEIPT);
    const payload = await call(client, "wallet_send", input);
    expect(payload["status"]).toBe("committed");
    expect(elicitations).toHaveLength(1);
    expect(elicitations[0]).toContain("0.25000000 VRSCTEST");
    expect(elicitations[0]).toContain("alice (RAlice1111111111111111111111111111)");
    expect(elicitations[0]).toContain("send-always-confirms");
    expect(ledger.getOutcome(input.requestId)?.state).toBe("broadcast");
  });

  it("denies when the human picks deny — zero backend calls", async () => {
    const { client, backend } = await makeHarness({ elicit: "deny-decision" });
    const payload = await call(client, "wallet_send", input);
    expect(payload["status"]).toBe("denied");
    expect(payload["reasonCode"]).toBe("human-declined");
    expect(backend.instructions).toHaveLength(0);
  });

  it("treats an explicit decline action as a refusal", async () => {
    const { client, backend } = await makeHarness({ elicit: "decline" });
    const payload = await call(client, "wallet_send", input);
    expect(payload["status"]).toBe("denied");
    expect(payload["reasonCode"]).toBe("human-declined");
    expect(backend.instructions).toHaveLength(0);
  });

  it("fails closed without the elicitation capability", async () => {
    const { client, backend, ledger } = await makeHarness();
    const payload = await call(client, "wallet_send", input);
    expect(payload["status"]).toBe("denied");
    expect(payload["reasonCode"]).toBe("no-elicitation");
    expect(backend.instructions).toHaveLength(0);
    expect(ledger.getOutcome(input.requestId)).toBeNull();
  });

  it("replays a known requestId without a second spend or prompt", async () => {
    const { client, backend, elicitations } = await makeHarness({ elicit: "approve" });
    backend.willSucceed(RECEIPT);
    const first = await call(client, "wallet_send", input);
    expect(first["status"]).toBe("committed");
    const second = await call(client, "wallet_send", input);
    expect(second["status"]).toBe("replayed");
    const prior = second["priorOutcome"] as Record<string, unknown>;
    expect(prior["state"]).toBe("broadcast");
    expect(prior["txid"]).toBe(TXID);
    expect(backend.instructions).toHaveLength(1);
    expect(elicitations).toHaveLength(1);
  });

  it("denies an unlisted recipient name before the gate", async () => {
    const { client, backend, ledger } = await makeHarness({ elicit: "approve" });
    const payload = await call(client, "wallet_send", { ...input, recipient: "mallory" });
    expect(payload["status"]).toBe("denied");
    expect(payload["reasonCode"]).toBe("recipient-not-listed");
    expect(backend.instructions).toHaveLength(0);
    expect(ledger.getOutcome(input.requestId)).toBeNull();
  });
});

describe("wallet_transaction_status", () => {
  it("answers unknown-request for a never-seen requestId", async () => {
    const { client } = await makeHarness();
    const payload = await call(client, "wallet_transaction_status", {
      requestId: "req-never-was",
    });
    expect(payload["status"]).toBe("unknown-request");
  });

  it("refreshes confirmations from the node and persists them", async () => {
    const { client, backend, reader, ledger } = await makeHarness({ elicit: "approve" });
    backend.willSucceed(RECEIPT);
    await call(client, "wallet_send", {
      requestId: "req-send-track1",
      amount: "0.1",
      currency: "VRSCTEST",
      recipient: "alice",
    });
    reader.confirmations.set(TXID, 3);
    const payload = await call(client, "wallet_transaction_status", {
      requestId: "req-send-track1",
    });
    expect(payload["state"]).toBe("confirmed");
    expect(payload["confirmations"]).toBe(3);
    expect(ledger.getOutcome("req-send-track1")?.confirmations).toBe(3);
    // A later, higher count keeps monotonically updating.
    reader.confirmations.set(TXID, 5);
    const later = await call(client, "wallet_transaction_status", {
      requestId: "req-send-track1",
    });
    expect(later["confirmations"]).toBe(5);
  });

  it("degrades to the recorded state when the node read fails", async () => {
    const { client, backend, reader } = await makeHarness({ elicit: "approve" });
    backend.willSucceed(RECEIPT);
    await call(client, "wallet_send", {
      requestId: "req-send-track2",
      amount: "0.1",
      currency: "VRSCTEST",
      recipient: "alice",
    });
    reader.failWith = new Error("gateway 502");
    const payload = await call(client, "wallet_transaction_status", {
      requestId: "req-send-track2",
    });
    expect(payload["state"]).toBe("broadcast");
    expect(payload["nodeNote"]).toContain("gateway 502");
  });
});

describe("ElicitationConfirmer", () => {
  async function bareServerWith(
    elicit: ElicitBehavior | undefined,
  ): Promise<{ confirmer: ElicitationConfirmer }> {
    const server = new McpServer({ name: "bare", version: "0" });
    const client =
      elicit === undefined
        ? new Client({ name: "bare-client", version: "0" })
        : new Client(
            { name: "bare-client", version: "0" },
            { capabilities: { elicitation: { form: {} } } },
          );
    if (elicit !== undefined) {
      client.setRequestHandler(ElicitRequestSchema, (): Promise<ElicitResult> => {
        if (elicit === "hang") {
          return new Promise<ElicitResult>(() => undefined);
        }
        throw new Error("unexpected behavior in this fixture");
      });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return { confirmer: new ElicitationConfirmer(server) };
  }

  it("is unavailable without the form-elicitation capability", async () => {
    const { confirmer } = await bareServerWith(undefined);
    expect(confirmer.available()).toBe(false);
    expect(await confirmer.confirm("msg", 1000)).toBe("unavailable");
  });

  it("maps an expired wait to timeout (fail closed)", async () => {
    const { confirmer } = await bareServerWith("hang");
    expect(confirmer.available()).toBe(true);
    expect(await confirmer.confirm("msg", 100)).toBe("timeout");
  });
});

// ─── Package A: report / position / prepaid tools ─────────────────────────

describe("wallet_spending_report", () => {
  it("lists recent requests with requestIds and aggregates spent amounts", async () => {
    const { client, backend } = await makeHarness();
    backend.willSucceed(RECEIPT).willSucceed({ ...RECEIPT, txid: PREV_TXID, changeOutpoint: `${PREV_TXID}:1` });
    await call(client, "wallet_topup_facilitator", {
      requestId: "req-report-1",
      amount: "0.2",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });
    await call(client, "wallet_topup_facilitator", {
      requestId: "req-report-2",
      amount: "0.3",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });

    const report = await call(client, "wallet_spending_report", {});
    expect(report["totalRequests"]).toBe(2);
    expect(report["totalSpent"]).toBe("0.50000000");
    const recent = report["recent"] as Array<Record<string, unknown>>;
    expect(recent.map((r) => r["requestId"])).toEqual(["req-report-2", "req-report-1"]);
    const buckets = report["buckets"] as Array<Record<string, unknown>>;
    expect(buckets).toHaveLength(1); // same day, same currency
    expect(buckets[0]?.["spent"]).toBe("0.50000000");
    expect(buckets[0]?.["txCount"]).toBe(2);
  });

  it("groups by recipient and filters by kind", async () => {
    const { client, backend } = await makeHarness();
    backend.willSucceed(RECEIPT);
    await call(client, "wallet_topup_facilitator", {
      requestId: "req-report-3",
      amount: "0.1",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });
    const report = await call(client, "wallet_spending_report", {
      groupBy: "recipient",
      kind: "topup",
    });
    const buckets = report["buckets"] as Array<Record<string, unknown>>;
    expect(buckets[0]?.["bucket"]).toBe("demo-facilitator");
    const empty = await call(client, "wallet_spending_report", { kind: "send" });
    expect(empty["totalRequests"]).toBe(0);
  });
});

describe("wallet_financial_position", () => {
  it("reports balances, cap usage, in-flight and burn in one payload", async () => {
    const { client, backend, reader } = await makeHarness();
    reader.balances = [{ currency: "VRSCTEST", sats: 100_000_000n }];
    backend.willSucceed(RECEIPT);
    await call(client, "wallet_topup_facilitator", {
      requestId: "req-pos-1",
      amount: "0.25",
      currency: "VRSCTEST",
      recipient: "demo-facilitator",
    });

    const position = await call(client, "wallet_financial_position", {});
    expect((position["balances"] as unknown[]).length).toBe(1);
    const caps = position["caps"] as Array<Record<string, unknown>>;
    const native = caps.find((c) => c["currency"] === "VRSCTEST");
    expect(native?.["spentToday"]).toBe("0.25000000");
    const inFlight = position["inFlight"] as Array<Record<string, unknown>>;
    expect(inFlight.map((r) => r["requestId"])).toContain("req-pos-1");
    const burn = position["burn"] as Record<string, string>;
    expect(burn["spent"]).toBe("0.25000000");
    expect(burn["runway"]).toContain("days");
  });
});

describe("wallet_prepaid_balance", () => {
  it("explains when the facilitator has no configured apiUrl", async () => {
    const { client } = await makeHarness();
    const payload = await call(client, "wallet_prepaid_balance", {
      facilitator: "demo-facilitator",
    });
    expect(payload["status"]).toBe("no-api-url");
  });

  it("explains starter-mode wallets have no facilitator-readable account", async () => {
    const { client } = await makeHarness({
      policy: {
        facilitators: [
          {
            name: "demo-facilitator",
            address: "RFacilitator1111111111111111111111",
            currency: "VRSCTEST",
            maxPerTx: "0.5",
            maxPerDay: "2",
            autoApprove: true,
            apiUrl: "http://127.0.0.1:9",
          },
        ],
      },
    });
    const payload = await call(client, "wallet_prepaid_balance", {
      facilitator: "demo-facilitator",
    });
    expect(payload["status"]).toBe("identity-required");
  });

  it("rejects names that are not allowlisted", async () => {
    const { client } = await makeHarness();
    const payload = await call(client, "wallet_prepaid_balance", { facilitator: "nope" });
    expect(payload["status"]).toBe("unknown-facilitator");
  });
});

describe("wallet_paid_fetch", () => {
  /** The service policy of `policyFileWithService`, under an identity agent. */
  const paidPolicy = policyFileWithService({
    agentAddress: "iAgent111111111111111111111111111",
  });

  /** A wire-realistic offer matching that policy (lowercase network id). */
  function offer(amount = "0.001") {
    return {
      kind: "offer" as const,
      offer: {
        amountSats: parseAmount(amount),
        asset: "VRSCTEST",
        network: "vrsctest",
        payTo: "service@",
        facilitator: "https://facilitator.example.test",
        canonicalDomain: "api.service.test",
        requirement: {
          scheme: "verus-prepaid-sig",
          schemeVersion: "0.1",
          network: "vrsctest",
          asset: "VRSCTEST",
          amount,
          amountUnit: "human" as const,
          payTo: "service@",
          facilitator: "https://facilitator.example.test",
          requiredHeaders: ["X-V402-Payer", "X-V402-Signature"],
          canonicalDomain: "api.service.test",
        },
      },
    };
  }

  it("pays an in-budget call and returns body + amount + requestId", async () => {
    const { client, paymentBackend, ledger } = await makeHarness({ policy: paidPolicy });
    paymentBackend.willPreflight(offer()).willPay({
      httpStatus: 200,
      contentType: "application/json",
      body: '{"answer":42}',
      bodyEncoding: "utf8",
      truncated: false,
    });

    const payload = await call(client, "wallet_paid_fetch", {
      requestId: "req-pf-mcp-1",
      service: "demo-api",
      path: "/v1/data",
    });
    expect(payload["status"]).toBe("settled");
    expect(payload["amountPaid"]).toBe("0.00100000");
    expect(payload["currency"]).toBe("VRSCTEST");
    expect(payload["httpStatus"]).toBe(200);
    expect(payload["body"]).toBe('{"answer":42}');
    expect(ledger.getOutcome("req-pf-mcp-1")?.state).toBe("settled");
  });

  it("denies an over-cap offer with a final structured denial", async () => {
    const { client, paymentBackend } = await makeHarness({ policy: paidPolicy });
    paymentBackend.willPreflight(offer("0.02")); // per-call cap is 0.01

    const payload = await call(client, "wallet_paid_fetch", {
      requestId: "req-pf-mcp-2",
      service: "demo-api",
    });
    expect(payload["status"]).toBe("denied");
    expect(payload["reasonCode"]).toBe("service-price-cap-exceeded");
    expect(paymentBackend.payments).toHaveLength(0);
  });

  it("replays a known requestId without paying twice", async () => {
    const { client, paymentBackend } = await makeHarness({ policy: paidPolicy });
    paymentBackend.willPreflight(offer()).willPay({
      httpStatus: 200,
      contentType: "text/plain",
      body: "once",
      bodyEncoding: "utf8",
      truncated: false,
    });

    const args = { requestId: "req-pf-mcp-3", service: "demo-api" };
    await call(client, "wallet_paid_fetch", args);
    const replay = await call(client, "wallet_paid_fetch", args);
    expect(replay["status"]).toBe("replayed");
    expect(paymentBackend.payments).toHaveLength(1);
  });

  it("explains starter-mode wallets cannot pay per request", async () => {
    const { client, paymentBackend } = await makeHarness({
      policy: policyFileWithService({
        addressMode: "starter-r-address",
        agentAddress: "RAgent1111111111111111111111111111",
        // Starter mode has tighter compiled caps — keep the fixture legal.
        currencies: [{ currency: "VRSCTEST", maxPerTx: "1", maxPerDay: "5", maxTotal: "25" }],
      }),
    });
    const payload = await call(client, "wallet_paid_fetch", {
      requestId: "req-pf-mcp-4",
      service: "demo-api",
    });
    // Starter mode is a fail-closed deny (owned by the gate, before any
    // preflight), not a top-level status.
    expect(payload["status"]).toBe("denied");
    expect(payload["reasonCode"]).toBe("identity-required");
    expect(paymentBackend.preflights).toHaveLength(0);
  });

  it("shows services with remainingToday in wallet_list_recipients", async () => {
    const { client } = await makeHarness({ policy: paidPolicy });
    const payload = await call(client, "wallet_list_recipients", {});
    const services = payload["services"] as Array<Record<string, unknown>>;
    expect(services).toHaveLength(1);
    expect(services[0]?.["name"]).toBe("demo-api");
    expect(services[0]?.["maxPricePerCall"]).toBe("0.01000000");
    expect(services[0]?.["remainingToday"]).toBe("0.05000000");
  });
});
