// PublicNodeReader against verus-rpc's MockTransport — responses round-trip
// through the real lossless JSON layer, so the satoshi-integer vs 8-decimal
// wire quirk of getaddressbalance is exercised for real.

import { describe, expect, it } from "vitest";
import { MockTransport, VerusClient } from "@chainvue/verus-rpc";

import { PublicNodeReader } from "../src/reader.js";

function makeReader(): { reader: PublicNodeReader; transport: MockTransport } {
  const transport = new MockTransport();
  const client = new VerusClient({ transport });
  return { reader: new PublicNodeReader(client, "VRSCTEST"), transport };
}

describe("PublicNodeReader.getBalances", () => {
  it("reports the native balance from the satoshi integer field", async () => {
    const { reader, transport } = makeReader();
    transport.respondJson("getaddressbalance", '{"balance":150000000,"received":150000000}');
    expect(await reader.getBalances("RAgent")).toEqual([
      { currency: "VRSCTEST", sats: 150000000n },
    ]);
  });

  it("adds non-native currencies from the 8-decimal map, native deduplicated", async () => {
    const { reader, transport } = makeReader();
    transport.respondJson(
      "getaddressbalance",
      '{"balance":150000000,"received":150000000,' +
        '"currencybalance":{"VRSCTEST":1.5,"TOKEN":2.25,"ALPHA":0.00000001}}',
    );
    expect(await reader.getBalances("RAgent")).toEqual([
      { currency: "VRSCTEST", sats: 150000000n },
      { currency: "ALPHA", sats: 1n },
      { currency: "TOKEN", sats: 225000000n },
    ]);
  });

  it("queries exactly the given address", async () => {
    const { reader, transport } = makeReader();
    transport.respondJson("getaddressbalance", '{"balance":0,"received":0}');
    await reader.getBalances("RAgent1111111111111111111111111111");
    expect(transport.calls).toEqual([
      {
        method: "getaddressbalance",
        params: [{ addresses: ["RAgent1111111111111111111111111111"] }],
      },
    ]);
  });
});

describe("PublicNodeReader.getConfirmations", () => {
  it("returns the confirmation count of a known tx", async () => {
    const { reader, transport } = makeReader();
    transport.respondJson("getrawtransaction", '{"txid":"ab","confirmations":7}');
    expect(await reader.getConfirmations("ab")).toBe(7);
  });

  it("returns 0 for a mempool tx without a confirmations field", async () => {
    const { reader, transport } = makeReader();
    transport.respondJson("getrawtransaction", '{"txid":"ab"}');
    expect(await reader.getConfirmations("ab")).toBe(0);
  });

  it("returns null when the node does not know the txid (-5)", async () => {
    const { reader, transport } = makeReader();
    transport.respondError(
      "getrawtransaction",
      -5,
      "No information available about transaction",
    );
    expect(await reader.getConfirmations("ab")).toBeNull();
  });

  it("propagates transport failures (the caller decides best-effort vs deny)", async () => {
    const { reader, transport } = makeReader();
    transport.failTransport("getrawtransaction", "network");
    await expect(reader.getConfirmations("ab")).rejects.toThrow();
  });
});
