// PaymentGate.execute end-to-end over the real PolicySource / SpendLedger /
// AuditLog with a scripted MockPaymentBackend: the binding sequence from
// idempotent replay through preflight, price gate, confirmation, reservation
// and the fail-closed settlement split.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseAmount } from "verus-rpc";
import { afterEach, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit.js";
import { StaticConfirmer } from "../src/confirm.js";
import { SpendLedger } from "../src/ledger/ledger.js";
import { PaymentGate, type PaidFetchRequest } from "../src/payment-gate.js";
import {
  MockPaymentBackend,
  PaymentRejectedError,
  PaymentSetupError,
  PaymentUncertainError,
  type PaidResponse,
  type PaymentOffer,
} from "../src/payment.js";
import { PolicySource } from "../src/policy/load.js";
import type { PolicyFileInput } from "../src/policy/schema.js";
import { FACILITATOR_API_URL, NOW, policyFileWithService, SERVICE_ORIGIN } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const dirs: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  while (closers.length > 0) {
    closers.pop()?.();
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

/** A wire-realistic offer matching the `policyFileWithService` fixture. */
function offer(overrides: Partial<PaymentOffer> = {}): PaymentOffer {
  const amount = overrides.amountSats ?? parseAmount("0.001");
  return {
    amountSats: amount,
    asset: "VRSCTEST",
    network: "vrsctest", // wire form: the protocol mandates lowercase
    payTo: "service@",
    facilitator: FACILITATOR_API_URL,
    canonicalDomain: "api.service.test",
    requirement: {
      scheme: "verus-prepaid-sig",
      schemeVersion: "0.1",
      network: "vrsctest",
      asset: "VRSCTEST",
      amount: "0.001",
      amountUnit: "human",
      payTo: "service@",
      facilitator: FACILITATOR_API_URL,
      requiredHeaders: ["X-V402-Payer", "X-V402-Signature"],
      canonicalDomain: "api.service.test",
    },
    ...overrides,
  };
}

function response(overrides: Partial<PaidResponse> = {}): PaidResponse {
  return {
    httpStatus: 200,
    contentType: "application/json",
    body: '{"ok":true}',
    bodyEncoding: "utf8",
    truncated: false,
    ...overrides,
  };
}

function request(overrides: Partial<PaidFetchRequest> = {}): PaidFetchRequest {
  return {
    requestId: "req-gate-0001",
    service: "demo-api",
    path: "/v1/data?q=1",
    method: "GET",
    ...overrides,
  };
}

interface GateHarness {
  gate: PaymentGate;
  backend: MockPaymentBackend;
  ledger: SpendLedger;
  confirmer: StaticConfirmer;
  dir: string;
}

function makeGate(
  opts: {
    policy?: Partial<PolicyFileInput>;
    confirmer?: StaticConfirmer;
  } = {},
): GateHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-pfgate-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "policy.json"),
    JSON.stringify(policyFileWithService(opts.policy ?? {}), null, 2),
    { mode: 0o600 },
  );
  const ledger = SpendLedger.open(dir, { clock: () => NOW });
  const audit = AuditLog.open(dir);
  closers.push(() => {
    audit.close();
    ledger.close();
  });
  const backend = new MockPaymentBackend();
  const confirmer = opts.confirmer ?? new StaticConfirmer("approved");
  const gate = new PaymentGate({
    policySource: new PolicySource(dir),
    ledger,
    backend,
    confirmer,
    audit,
    stateDir: dir,
    clock: () => NOW,
  });
  return { gate, backend, ledger, confirmer, dir };
}

describe("the paid path", () => {
  it("pays an in-budget offer, settles it and records the spend", async () => {
    const { gate, backend, ledger } = makeGate();
    backend.willPreflight({ kind: "offer", offer: offer() }).willPay(response());

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("settled");
    if (outcome.status === "settled") {
      expect(outcome.amountSats).toBe(parseAmount("0.001"));
      expect(outcome.currency).toBe("VRSCTEST");
      expect(outcome.response.body).toBe('{"ok":true}');
    }

    // The URL is built from the POLICY origin + the agent's path.
    expect(backend.preflights[0]?.url.href).toBe(`${SERVICE_ORIGIN}/v1/data?q=1`);
    expect(backend.payments[0]?.offer.amountSats).toBe(parseAmount("0.001"));

    const row = ledger.getOutcome("req-gate-0001");
    expect(row?.state).toBe("settled");
    expect(row?.countsAsSpent).toBe(true);
    expect(ledger.serviceSpentInWindowSats(SERVICE_ORIGIN, "VRSCTEST", DAY_MS, NOW)).toBe(
      parseAmount("0.001"),
    );
  });

  it("passes a no-payment answer through without touching the ledger", async () => {
    const { gate, backend, ledger } = makeGate();
    backend.willPreflight({ kind: "response", response: response({ body: "free" }) });

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("no-payment-required");
    expect(backend.payments).toHaveLength(0);
    expect(ledger.getOutcome("req-gate-0001")).toBeNull();
  });

  it("settles a paid non-2xx answer as spent (fail closed) with the honest status", async () => {
    const { gate, backend, ledger } = makeGate();
    backend
      .willPreflight({ kind: "offer", offer: offer() })
      .willPay(response({ httpStatus: 500, body: "boom" }));

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("settled");
    if (outcome.status === "settled") {
      expect(outcome.response.httpStatus).toBe(500);
    }
    expect(ledger.getOutcome("req-gate-0001")?.countsAsSpent).toBe(true);
  });
});

describe("denials pay nothing and leave no spend", () => {
  it("denies an unlisted service before any network contact", async () => {
    const { gate, backend, ledger } = makeGate();
    const outcome = await gate.execute(request({ service: "not-a-service" }));
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("service-not-listed");
    }
    expect(backend.preflights).toHaveLength(0);
    expect(ledger.getOutcome("req-gate-0001")).toBeNull();
  });

  it("denies an offer over the per-call cap without paying", async () => {
    const { gate, backend, ledger } = makeGate();
    backend.willPreflight({
      kind: "offer",
      offer: offer({ amountSats: parseAmount("0.011") }), // cap is 0.01
    });

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("service-price-cap-exceeded");
    }
    expect(backend.payments).toHaveLength(0);
    expect(ledger.getOutcome("req-gate-0001")).toBeNull();
  });

  it("denies when the daily budget is exhausted", async () => {
    const { gate, backend, ledger } = makeGate();
    // Burn the 0.05 daily budget with five settled 0.01 calls.
    for (let i = 0; i < 5; i += 1) {
      backend
        .willPreflight({ kind: "offer", offer: offer({ amountSats: parseAmount("0.01") }) })
        .willPay(response());
      const paid = await gate.execute(request({ requestId: `req-gate-fill-${i}` }));
      expect(paid.status).toBe("settled");
    }
    backend.willPreflight({ kind: "offer", offer: offer() });
    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("service-daily-cap-exceeded");
    }
    expect(ledger.getOutcome("req-gate-0001")).toBeNull();
  });

  it("honors the agent's own tighter maxPrice", async () => {
    const { gate, backend } = makeGate();
    backend.willPreflight({ kind: "offer", offer: offer() }); // asks 0.001
    const outcome = await gate.execute(request({ maxPriceSats: parseAmount("0.0005") }));
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("agent-max-price-exceeded");
    }
    expect(backend.payments).toHaveLength(0);
  });

  it("denies an unreachable preflight and an invalid offer as clean no-ops", async () => {
    const { gate, backend, ledger } = makeGate();
    backend.willPreflightThrow(
      new PaymentSetupError("preflight-unreachable", "ECONNREFUSED"),
    );
    const unreachable = await gate.execute(request());
    expect(unreachable.status).toBe("denied");
    if (unreachable.status === "denied") {
      expect(unreachable.reasonCode).toBe("preflight-unreachable");
    }

    backend.willPreflightThrow(new PaymentSetupError("offer-invalid", "not a v402 envelope"));
    const invalid = await gate.execute(request({ requestId: "req-gate-0002" }));
    expect(invalid.status).toBe("denied");
    if (invalid.status === "denied") {
      expect(invalid.reasonCode).toBe("offer-invalid");
    }
    expect(ledger.getOutcome("req-gate-0001")).toBeNull();
    expect(ledger.getOutcome("req-gate-0002")).toBeNull();
  });
});

describe("pre-offer enablement (no network contact until it passes)", () => {
  it("denies a disarmed wallet before any preflight (no exfiltration channel)", async () => {
    const { gate, backend, ledger } = makeGate({ policy: { armRequired: true } });
    const outcome = await gate.execute(request({ method: "POST", body: "secrets" }));
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("not-armed");
    }
    expect(backend.preflights).toHaveLength(0);
    expect(ledger.getOutcome("req-gate-0001")).toBeNull();
  });

  it("denies a starter-mode wallet before any preflight", async () => {
    const { gate, backend } = makeGate({
      policy: {
        addressMode: "starter-r-address",
        agentAddress: "RAgent1111111111111111111111111111",
        currencies: [{ currency: "VRSCTEST", maxPerTx: "1", maxPerDay: "5", maxTotal: "25" }],
      },
    });
    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("identity-required");
    }
    expect(backend.preflights).toHaveLength(0);
  });

  it("denies before any preflight when the backend reports a setup problem", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peculium-pfgate-"));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "policy.json"),
      JSON.stringify(policyFileWithService(), null, 2),
      { mode: 0o600 },
    );
    const ledger = SpendLedger.open(dir, { clock: () => NOW });
    const audit = AuditLog.open(dir);
    closers.push(() => {
      audit.close();
      ledger.close();
    });
    const backend = new MockPaymentBackend();
    const notReady = Object.assign(backend, {
      setupProblem: () => ({ code: "keystore-locked", message: "locked" }),
    });
    const gate = new PaymentGate({
      policySource: new PolicySource(dir),
      ledger,
      backend: notReady,
      confirmer: new StaticConfirmer("approved"),
      audit,
      stateDir: dir,
      clock: () => NOW,
    });
    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("keystore-locked");
    }
    expect(backend.preflights).toHaveLength(0);
  });

  it("audits a no-payment-required answer (the exchange is never invisible)", async () => {
    const { gate, backend, dir } = makeGate();
    backend.willPreflight({ kind: "response", response: response({ body: "free" }) });
    await gate.execute(request());
    const audit = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
    expect(audit).toContain("paid-fetch-no-payment");
  });
});

describe("failure settlement (the money semantics)", () => {
  it("releases the budget when the paid attempt gets another 402", async () => {
    const { gate, backend, ledger } = makeGate();
    backend
      .willPreflight({ kind: "offer", offer: offer() })
      .willPayThrow(new PaymentRejectedError("offer changed", 402));

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.stage).toBe("payment-rejected");
    }
    const row = ledger.getOutcome("req-gate-0001");
    expect(row?.state).toBe("failed");
    expect(row?.countsAsSpent).toBe(false);
    expect(ledger.serviceSpentInWindowSats(SERVICE_ORIGIN, "VRSCTEST", DAY_MS, NOW)).toBe(0n);
  });

  it("releases the budget on a setup failure after reservation (nothing sent)", async () => {
    const { gate, backend, ledger } = makeGate();
    backend
      .willPreflight({ kind: "offer", offer: offer() })
      .willPayThrow(new PaymentSetupError("keystore-locked", "no passphrase"));

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.stage).toBe("build");
    }
    expect(ledger.getOutcome("req-gate-0001")?.countsAsSpent).toBe(false);
  });

  it("keeps an unanswered payment reserved as ambiguous (fail closed)", async () => {
    const { gate, backend, ledger } = makeGate();
    backend
      .willPreflight({ kind: "offer", offer: offer() })
      .willPayThrow(new PaymentUncertainError("no answer after 3 attempts"));

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("ambiguous");
    const row = ledger.getOutcome("req-gate-0001");
    expect(row?.state).toBe("ambiguous");
    expect(row?.countsAsSpent).toBe(true);
    expect(ledger.serviceSpentInWindowSats(SERVICE_ORIGIN, "VRSCTEST", DAY_MS, NOW)).toBe(
      parseAmount("0.001"),
    );
  });

  it("treats an UNEXPECTED pay-step throw as ambiguous, never as a release", async () => {
    const { gate, backend, ledger } = makeGate();
    backend
      .willPreflight({ kind: "offer", offer: offer() })
      .willPayThrow(new Error("bug in the backend"));

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("ambiguous");
    expect(ledger.getOutcome("req-gate-0001")?.countsAsSpent).toBe(true);
  });
});

describe("idempotency", () => {
  it("replays a known requestId without paying again", async () => {
    const { gate, backend } = makeGate();
    backend.willPreflight({ kind: "offer", offer: offer() }).willPay(response());

    const first = await gate.execute(request());
    expect(first.status).toBe("settled");
    const second = await gate.execute(request());
    expect(second.status).toBe("replayed");
    if (second.status === "replayed") {
      expect(second.snapshot.state).toBe("settled");
    }
    expect(backend.preflights).toHaveLength(1);
    expect(backend.payments).toHaveLength(1);
  });
});

describe("confirmation (autoApprove: false services)", () => {
  const manualService: Partial<PolicyFileInput> = {
    services: [
      {
        name: "demo-api",
        origin: SERVICE_ORIGIN,
        facilitator: "demo-facilitator",
        currency: "VRSCTEST",
        maxPricePerCall: "0.01",
        maxPerDay: "0.05",
        autoApprove: false,
      },
    ],
  };

  it("pays after the human approves, recording the confirmed approval", async () => {
    const confirmer = new StaticConfirmer("approved");
    const { gate, backend, ledger } = makeGate({ policy: manualService, confirmer });
    backend.willPreflight({ kind: "offer", offer: offer() }).willPay(response());

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("settled");
    expect(confirmer.received).toHaveLength(1);
    expect(confirmer.received[0]?.message).toContain("Amount: 0.00100000 VRSCTEST");
    expect(confirmer.received[0]?.message).toContain("demo-api");
    expect(ledger.getOutcome("req-gate-0001")?.approval).toBe("human-confirmed");
  });

  it("denies when the human declines — nothing reserved, nothing paid", async () => {
    const confirmer = new StaticConfirmer("denied");
    const { gate, backend, ledger } = makeGate({ policy: manualService, confirmer });
    backend.willPreflight({ kind: "offer", offer: offer() });

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("human-declined");
    }
    expect(backend.payments).toHaveLength(0);
    expect(ledger.getOutcome("req-gate-0001")).toBeNull();
  });

  it("denies on confirmation timeout", async () => {
    const confirmer = new StaticConfirmer("timeout");
    const { gate, backend } = makeGate({ policy: manualService, confirmer });
    backend.willPreflight({ kind: "offer", offer: offer() });

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("confirm-timeout");
    }
    expect(backend.payments).toHaveLength(0);
  });

  it("fails closed when no elicitation channel exists (never silently auto-approves)", async () => {
    const confirmer = new StaticConfirmer("approved", { available: false });
    const { gate, backend } = makeGate({ policy: manualService, confirmer });
    backend.willPreflight({ kind: "offer", offer: offer() });

    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("no-elicitation");
    }
    expect(backend.payments).toHaveLength(0);
  });
});

describe("engine pins at the gate level", () => {
  it("denies a wrong-network offer read from the wire", async () => {
    const { gate, backend } = makeGate();
    backend.willPreflight({ kind: "offer", offer: offer({ network: "vrsc" }) });
    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("offer-network-mismatch");
    }
    expect(backend.payments).toHaveLength(0);
  });

  it("denies an offer clearing through a foreign facilitator", async () => {
    const { gate, backend } = makeGate();
    backend.willPreflight({
      kind: "offer",
      offer: offer({ facilitator: "https://rogue.example.test" }),
    });
    const outcome = await gate.execute(request());
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reasonCode).toBe("offer-facilitator-mismatch");
    }
    expect(backend.payments).toHaveLength(0);
  });
});
