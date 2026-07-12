import { formatAmount, parseAmount } from "verus-rpc";
import { describe, expect, it } from "vitest";

import { renderConfirmMessage, StaticConfirmer, type ConfirmContext } from "../src/confirm.js";
import { makePolicy, RECIPIENT_ADDRESS, send } from "./helpers.js";

function context(overrides: Partial<ConfirmContext> = {}): ConfirmContext {
  return {
    policy: makePolicy(),
    spentInWindowSats: parseAmount("1"),
    currencyCaps: { maxPerDaySats: parseAmount("8") },
    confirmReason: "send-always-confirms",
    ...overrides,
  };
}

describe("renderConfirmMessage", () => {
  it("carries kind, amount, recipient pair, reason, day usage, network and warning", () => {
    const intent = send({ amountSats: parseAmount("0.5") });
    const message = renderConfirmMessage(intent, context());
    expect(message).toContain("(send)");
    expect(message).toContain(`Amount: ${formatAmount(parseAmount("0.5"))} VRSCTEST`);
    expect(message).toContain(`Recipient: alice (${RECIPIENT_ADDRESS})`);
    expect(message).toContain("Why confirmation is needed: send-always-confirms");
    expect(message).toContain(
      `24h usage after this spend: ${formatAmount(parseAmount("1.5"))} of ` +
        `${formatAmount(parseAmount("8"))} VRSCTEST`,
    );
    expect(message).toContain("Network: VRSCTEST");
    expect(message).toContain("cannot be undone");
  });

  it("is deterministic — identical inputs render the identical string", () => {
    const intent = send();
    expect(renderConfirmMessage(intent, context())).toBe(renderConfirmMessage(intent, context()));
  });
});

describe("StaticConfirmer", () => {
  it("returns its fixed outcome and records message + timeout", async () => {
    const confirmer = new StaticConfirmer("denied");
    expect(confirmer.available()).toBe(true);
    await expect(confirmer.confirm("msg-1", 30_000)).resolves.toBe("denied");
    await expect(confirmer.confirm("msg-2", 60_000)).resolves.toBe("denied");
    expect(confirmer.received).toEqual([
      { message: "msg-1", timeoutMs: 30_000 },
      { message: "msg-2", timeoutMs: 60_000 },
    ]);
  });

  it("can be constructed unavailable and runs the onConfirm hook first", async () => {
    expect(new StaticConfirmer("approved", { available: false }).available()).toBe(false);
    const order: string[] = [];
    const confirmer = new StaticConfirmer("approved", {
      onConfirm: () => {
        order.push("hook");
      },
    });
    order.push(await confirmer.confirm("msg", 1_000));
    expect(order).toEqual(["hook", "approved"]);
  });
});
