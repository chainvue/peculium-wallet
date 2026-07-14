// V402PaymentBackend — the wire mechanics under a scripted fetch: preflight
// pass-through and offer parsing, byte-verbatim signing of the VETTED offer,
// bodyHash extension, and the fail-closed error taxonomy (402-again =
// rejected/no-op, no answer = uncertain, non-402 statuses returned).

import { describe, expect, it } from "vitest";

import {
  parse402Offer,
  PaymentRejectedError,
  PaymentSetupError,
  PaymentUncertainError,
  V402PaymentBackend,
  type PaidRequest,
} from "../src/payment.js";
import { MockReader } from "../src/reader.js";
import { NOW } from "./helpers.js";

const OFFER_BODY = {
  version: "v402/0.1",
  accepts: [
    {
      scheme: "verus-prepaid-sig",
      schemeVersion: "0.1",
      network: "vrsctest", // wire form: the protocol mandates lowercase network ids
      asset: "VRSCTEST",
      amount: "0.001",
      amountUnit: "human",
      payTo: "service@",
      facilitator: "https://facilitator.example.test",
      requiredHeaders: ["X-V402-Payer", "X-V402-Signature"],
      canonicalDomain: "api.service.test",
    },
  ],
};

function request(overrides: Partial<PaidRequest> = {}): PaidRequest {
  return {
    url: new URL("https://api.service.test/v1/data?q=1"),
    method: "GET",
    agentAddress: "iAgent111111111111111111111111111",
    network: "VRSCTEST",
    ...overrides,
  };
}

/** A fetch that replays scripted responses (or throws scripted errors). */
function scriptedFetch(
  plans: (Response | Error)[],
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const plan = plans.shift();
    if (plan === undefined) {
      return Promise.reject(new Error("scriptedFetch: no plan left"));
    }
    return plan instanceof Error ? Promise.reject(plan) : Promise.resolve(plan);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json402(body: unknown = OFFER_BODY): Response {
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

function makeBackend(plans: (Response | Error)[]): {
  backend: V402PaymentBackend;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const { fetchImpl, calls } = scriptedFetch(plans);
  const backend = new V402PaymentBackend({
    reader: new MockReader(),
    stateDir: "/nonexistent",
    fetchImpl,
    clock: () => NOW,
    makeSigner: () =>
      Promise.resolve({
        payer: "agent@",
        signer: { signMessage: (message: string) => Promise.resolve(`c2ln:${message.length}`) },
      }),
  });
  return { backend, calls };
}

describe("preflight", () => {
  it("passes a non-402 answer through with a bounded body", async () => {
    const { backend, calls } = makeBackend([
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    const result = await backend.preflight(request());
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.httpStatus).toBe(200);
      expect(result.response.body).toBe("hello");
      expect(result.response.bodyEncoding).toBe("utf8");
    }
    // The unpaid preflight carries NO payment headers.
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("X-V402-Signature")).toBeNull();
  });

  it("parses a 402 into a typed offer", async () => {
    const { backend } = makeBackend([json402()]);
    const result = await backend.preflight(request());
    expect(result.kind).toBe("offer");
    if (result.kind === "offer") {
      expect(result.offer.amountSats).toBe(100_000n); // 0.001
      expect(result.offer.asset).toBe("VRSCTEST");
      expect(result.offer.canonicalDomain).toBe("api.service.test");
      expect(result.offer.facilitator).toBe("https://facilitator.example.test");
    }
  });

  it("rejects a 402 without a supported scheme as a clean no-op", async () => {
    const body = {
      version: "v402/0.1",
      accepts: [{ scheme: "other-scheme", schemeVersion: "9.9" }],
    };
    const { backend } = makeBackend([json402(body)]);
    await expect(backend.preflight(request())).rejects.toThrow(PaymentSetupError);
  });

  it("rejects a non-JSON 402 as a clean no-op", async () => {
    const { backend } = makeBackend([new Response("<html>", { status: 402 })]);
    await expect(backend.preflight(request())).rejects.toThrow(PaymentSetupError);
  });

  it("maps a preflight transport failure to a setup error (nothing paid)", async () => {
    const { backend } = makeBackend([new Error("ECONNREFUSED")]);
    await expect(backend.preflight(request())).rejects.toMatchObject({
      code: "preflight-unreachable",
    });
  });

  it("never follows redirects and always bounds the wait (no leaked signed headers, no hang)", async () => {
    const { backend, calls } = makeBackend([
      new Response("hi", { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    await backend.preflight(request());
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("setupProblem (backend readiness)", () => {
  it("reports keystore-locked when no passphrase is set and no DI signer exists", () => {
    const { fetchImpl } = scriptedFetch([]);
    const backend = new V402PaymentBackend({
      reader: new MockReader(),
      stateDir: "/nonexistent",
      fetchImpl,
      clock: () => NOW,
    });
    const prior = process.env["PECULIUM_KEYSTORE_PASSPHRASE"];
    delete process.env["PECULIUM_KEYSTORE_PASSPHRASE"];
    try {
      expect(backend.setupProblem()?.code).toBe("keystore-locked");
    } finally {
      if (prior !== undefined) {
        process.env["PECULIUM_KEYSTORE_PASSPHRASE"] = prior;
      }
    }
  });

  it("is ready when a DI signer is injected (tests never need the keystore)", () => {
    const { backend } = makeBackend([]);
    expect(backend.setupProblem()).toBeNull();
  });
});

describe("parse402Offer", () => {
  it("rejects a non-positive amount", async () => {
    const body = structuredClone(OFFER_BODY);
    body.accepts[0]!.amount = "0";
    await expect(parse402Offer(json402(body))).rejects.toThrow(PaymentSetupError);
  });
});

describe("pay", () => {
  async function vettedOffer(): Promise<
    Extract<Awaited<ReturnType<V402PaymentBackend["preflight"]>>, { kind: "offer" }>["offer"]
  > {
    const { backend } = makeBackend([json402()]);
    const result = await backend.preflight(request());
    if (result.kind !== "offer") {
      throw new Error("fixture: expected an offer");
    }
    return result.offer;
  }

  it("sends the vetted amount byte-verbatim with all payment headers", async () => {
    const offer = await vettedOffer();
    const { backend, calls } = makeBackend([new Response("data", { status: 200 })]);
    const response = await backend.pay(request(), offer);
    expect(response.httpStatus).toBe(200);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("X-V402-Scheme")).toBe("verus-prepaid-sig/0.1");
    expect(headers.get("X-V402-Payer")).toBe("agent@");
    expect(headers.get("X-V402-Amount")).toBe("0.001"); // the VETTED price
    expect(headers.get("X-V402-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(headers.get("X-V402-Issued-At")).toBe(String(Math.floor(NOW.getTime() / 1000)));
    expect(headers.get("X-V402-Signature")).toContain("c2ln:");
    // GET with no body: no extensions header.
    expect(headers.get("X-V402-Extensions")).toBeNull();
  });

  it("binds the body hash into the signed extensions for body-carrying calls", async () => {
    const offer = await vettedOffer();
    const { backend, calls } = makeBackend([new Response("ok", { status: 200 })]);
    await backend.pay(request({ method: "POST", body: '{"q":"verus"}' }), offer);
    const headers = new Headers(calls[0]?.init?.headers);
    const extensions = Buffer.from(
      headers.get("X-V402-Extensions") ?? "",
      "base64",
    ).toString("utf8");
    // serializeExtensionBlock emits the canonical `key: value` line form.
    expect(extensions).toMatch(/^scheme\.bodyHash: sha256:[0-9a-f]{64}$/m);
  });

  it("maps a second 402 to PaymentRejectedError (proven no-op)", async () => {
    const offer = await vettedOffer();
    const { backend } = makeBackend([json402()]);
    await expect(backend.pay(request(), offer)).rejects.toThrow(PaymentRejectedError);
  });

  it("returns non-402 error statuses as responses (the gate settles them)", async () => {
    const offer = await vettedOffer();
    const { backend } = makeBackend([new Response("boom", { status: 500 })]);
    const response = await backend.pay(request(), offer);
    expect(response.httpStatus).toBe(500);
  });

  it("retries pure network errors with the SAME requestId, then goes uncertain", async () => {
    const offer = await vettedOffer();
    const { backend, calls } = makeBackend([
      new Error("socket hang up"),
      new Error("socket hang up"),
      new Error("socket hang up"),
    ]);
    await expect(backend.pay(request(), offer)).rejects.toThrow(PaymentUncertainError);
    expect(calls).toHaveLength(3);
    const ids = calls.map((call) => new Headers(call.init?.headers).get("X-V402-Request-Id"));
    expect(new Set(ids).size).toBe(1); // idempotent reserve: one ULID
  });

  it("recovers when a retry succeeds after a transport error", async () => {
    const offer = await vettedOffer();
    const { backend, calls } = makeBackend([
      new Error("reset"),
      new Response("late ok", { status: 200 }),
    ]);
    const response = await backend.pay(request(), offer);
    expect(response.httpStatus).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("treats a 402 AFTER a prior unanswered send as uncertain, not a clean no-op", async () => {
    // Attempt 0's signed request may already have debited; a later 402 is
    // then no proof of no-op, so the amount must stay reserved (uncertain).
    const offer = await vettedOffer();
    const { backend } = makeBackend([new Error("socket hang up"), json402()]);
    await expect(backend.pay(request(), offer)).rejects.toThrow(PaymentUncertainError);
  });

  it("truncates an oversize body at the cap instead of buffering it whole", async () => {
    const offer = await vettedOffer();
    const big = "a".repeat(256 * 1024 + 5_000);
    const { backend } = makeBackend([
      new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    const response = await backend.pay(request(), offer);
    expect(response.truncated).toBe(true);
    expect(Buffer.byteLength(response.body, "utf8")).toBe(256 * 1024);
  });

  it("maps a signer failure to a setup error (nothing sent)", async () => {
    const offer = await vettedOffer();
    const { fetchImpl, calls } = scriptedFetch([]);
    const backend = new V402PaymentBackend({
      reader: new MockReader(),
      stateDir: "/nonexistent",
      fetchImpl,
      clock: () => NOW,
      makeSigner: () =>
        Promise.resolve({
          payer: "agent@",
          signer: { signMessage: () => Promise.reject(new Error("no key")) },
        }),
    });
    await expect(backend.pay(request(), offer)).rejects.toMatchObject({
      code: "signing-failed",
    });
    expect(calls).toHaveLength(0);
  });

  it("returns binary bodies base64-encoded", async () => {
    const offer = await vettedOffer();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { backend } = makeBackend([
      new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
    ]);
    const response = await backend.pay(request(), offer);
    expect(response.bodyEncoding).toBe("base64");
    expect(Buffer.from(response.body, "base64")).toEqual(Buffer.from(png));
  });
});
