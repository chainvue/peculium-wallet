// Shared fixtures for the domain-core tests. Everything is built through
// the real parsePolicy so the fixtures themselves prove the schema accepts
// realistic configs.

import { parseAmount } from "verus-rpc";

import type { PaidFetchIntent, SendIntent, TopupIntent } from "../src/intents.js";
import type { LedgerView } from "../src/policy/engine.js";
import { parsePolicy, type Policy, type PolicyFileInput } from "../src/policy/schema.js";
import type { WalletState } from "../src/state.js";

/** The injected clock for every deterministic engine test. */
export const NOW = new Date("2026-07-12T12:00:00.000Z");

export const FACILITATOR_ADDRESS = "RFacilitator1111111111111111111111";
export const RECIPIENT_ADDRESS = "RAlice1111111111111111111111111111";
export const FACILITATOR_API_URL = "https://facilitator.example.test";
export const SERVICE_ORIGIN = "https://api.service.test";

/** A valid policy.json object; override fields per test. */
export function policyFile(overrides: Partial<PolicyFileInput> = {}): PolicyFileInput {
  return {
    schemaVersion: 1,
    network: "VRSCTEST",
    agentAddress: "RAgent1111111111111111111111111111",
    addressMode: "verusid",
    currencies: [
      { currency: "VRSCTEST", maxPerTx: "2", maxPerDay: "8", maxTotal: "20" },
      { currency: "TOKEN", maxPerTx: "100", maxPerDay: "500", maxTotal: "1000" },
    ],
    facilitators: [
      {
        name: "demo-facilitator",
        address: FACILITATOR_ADDRESS,
        currency: "VRSCTEST",
        maxPerTx: "0.5",
        maxPerDay: "2",
        autoApprove: true,
      },
    ],
    recipients: [{ name: "alice", address: RECIPIENT_ADDRESS }],
    rate: { maxSendsPerHour: 10, minSecondsBetweenSends: 0, dedupeWindowSeconds: 600 },
    armRequired: false,
    confirmTimeoutSeconds: 120,
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

export function makePolicy(overrides: Partial<PolicyFileInput> = {}): Policy {
  return parsePolicy(policyFile(overrides));
}

/** A policy whose facilitator has an apiUrl and funds one paid service. */
export function policyFileWithService(overrides: Partial<PolicyFileInput> = {}): PolicyFileInput {
  return policyFile({
    facilitators: [
      {
        name: "demo-facilitator",
        address: FACILITATOR_ADDRESS,
        currency: "VRSCTEST",
        maxPerTx: "0.5",
        maxPerDay: "2",
        autoApprove: true,
        apiUrl: FACILITATOR_API_URL,
      },
    ],
    services: [
      {
        name: "demo-api",
        origin: SERVICE_ORIGIN,
        facilitator: "demo-facilitator",
        currency: "VRSCTEST",
        maxPricePerCall: "0.01",
        maxPerDay: "0.05",
        autoApprove: true,
      },
    ],
    ...overrides,
  });
}

export function makePolicyWithService(overrides: Partial<PolicyFileInput> = {}): Policy {
  return parsePolicy(policyFileWithService(overrides));
}

/** A paid-fetch intent matching the `policyFileWithService` fixture. */
export function paidFetch(overrides: Partial<PaidFetchIntent> = {}): PaidFetchIntent {
  return {
    kind: "paid-fetch",
    requestId: "req-fetch-0001",
    amountSats: parseAmount("0.001"),
    currency: "VRSCTEST",
    recipientAddress: SERVICE_ORIGIN,
    recipientName: "demo-api",
    method: "GET",
    path: "/v1/data",
    offerNetwork: "vrsctest", // wire form: the protocol mandates lowercase
    payTo: "service@",
    offerFacilitator: FACILITATOR_API_URL,
    canonicalDomain: "api.service.test",
    ...overrides,
  };
}

/** Native cap entries pinned exactly at the verusid hard caps. */
export const NATIVE_AT_HARD_CAPS = [
  { currency: "VRSCTEST", maxPerTx: "10", maxPerDay: "50", maxTotal: "250" },
  { currency: "TOKEN", maxPerTx: "100", maxPerDay: "500", maxTotal: "1000" },
];

/** Native cap entries pinned exactly at the starter hard caps. */
export const NATIVE_AT_STARTER_CAPS = [
  { currency: "VRSCTEST", maxPerTx: "1", maxPerDay: "5", maxTotal: "25" },
  { currency: "TOKEN", maxPerTx: "100", maxPerDay: "500", maxTotal: "1000" },
];

/** An all-zeros LedgerView; override the aggregates a test cares about. */
export function makeLedger(overrides: Partial<LedgerView> = {}): LedgerView {
  return {
    spentInWindowSats: () => 0n,
    facilitatorSpentInWindowSats: () => 0n,
    totalSpentSats: () => 0n,
    attemptsInWindow: () => 0,
    lastAttemptAt: () => null,
    hasFingerprintInWindow: () => false,
    paidFetchSpentInWindowSats: () => 0n,
    serviceSpentInWindowSats: () => 0n,
    ...overrides,
  };
}

export function topup(overrides: Partial<TopupIntent> = {}): TopupIntent {
  return {
    kind: "topup",
    requestId: "req-topup-0001",
    amountSats: parseAmount("0.1"),
    currency: "VRSCTEST",
    recipientAddress: FACILITATOR_ADDRESS,
    recipientName: "demo-facilitator",
    ...overrides,
  };
}

export function send(overrides: Partial<SendIntent> = {}): SendIntent {
  return {
    kind: "send",
    requestId: "req-send-00001",
    amountSats: parseAmount("0.1"),
    currency: "VRSCTEST",
    recipientAddress: RECIPIENT_ADDRESS,
    recipientName: "alice",
    ...overrides,
  };
}

export const IDLE_STATE: WalletState = {
  schemaVersion: 1,
  armedUntil: null,
  grant: null,
};

/** ISO timestamp at `NOW + offsetMs`. */
export function isoAt(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}
