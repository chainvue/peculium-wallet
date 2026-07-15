# Peculium

**The safe way to give an AI agent money.** A Verus wallet for AI agents: an
MCP server the agent drives within strict, human-set limits, plus a CLI only
the human uses to set them.

> Roman law's *peculium*: property entrusted to a dependent to trade with —
> ownership retained, liability capped, withdrawable at any time.

**Pre-release · testnet (VRSCTEST) only** — mainnet is refused in code. Fund it
only with what you'd lose to autonomy.

## Quickstart

```bash
npx @chainvue/peculium-wallet init --starter   # fresh key, tiny caps, VRSCTEST
# fund the printed address (faucet: https://faucet.verus.services)
npx @chainvue/peculium-wallet doctor           # verify everything
npx @chainvue/peculium-wallet allow recipient alice RBob…
```

`init` prints an MCP config block — add it to your host with your passphrase in
`PECULIUM_KEYSTORE_PASSPHRASE`, and restart. The agent can now `wallet_send`;
every send pops a confirmation dialog on **your** screen with the exact amount,
recipient, and remaining budget. `peculium history` shows everything it tried.

## Security model

**The LLM is untrusted input** — every rule follows from that:

- **Narrow tools only.** The agent gets 11 read/spend tools. Nothing that
  changes policy, adds a recipient, raises a cap, or touches a key — those are
  CLI-only, human-only.
- **Recipients & services are names, not addresses/URLs.** The agent names an
  allowlist entry; the wallet resolves and re-validates it. Prompt-injected
  addresses have nowhere to go.
- **Sends require human confirmation** (MCP elicitation). No elicitation → fail
  closed. Topups may auto-approve only within a facilitator's own budget.
- **Caps enforced twice**: per-currency policy caps (per-tx / trailing-24h /
  lifetime) and compiled-in hard caps a hand-edited `policy.json` can't widen.
- **Append-only money memory**: every attempt — denials included — lands in a
  crash-safe ledger; anything that *might* have moved money counts against caps.
- **Lite + offline**: local signing (scrypt + AES-256-GCM keystore) against
  public nodes. No daemon, no chain sync.
- **Identity mode**: funds can be held by the agent's VerusID; control is
  re-verified on-chain every spend, so a revocation from your cold wallet stops
  spending immediately.

**The honest limit:** the spending key lives in the wallet process. Caps bound
accidents and prompt injection — not a compromised host, which means the hot
balance is gone. Hot-wallet discipline is the real loss bound.

## The agent's tools

| Tool | Gate |
|---|---|
| `wallet_balance`, `wallet_receive_address`, `wallet_list_recipients` | read-only |
| `wallet_prepaid_balance` | read-only — signed balance query at a v402 facilitator |
| `wallet_spending_report`, `wallet_financial_position` | read-only — ledger aggregates + runway |
| `wallet_precheck` | dry-run — never reserves, never spends |
| `wallet_transaction_status` | read-only + confirmation refresh |
| `wallet_topup_facilitator` | full gate; may auto-approve within the facilitator budget |
| `wallet_send` | full gate; always human-confirmed |
| `wallet_paid_fetch` | payment gate; pays a v402 API call, price-capped per call and per day |

## The human's CLI

`init` · `status` · `history` · `doctor` · `grant` (session budget) ·
`arm`/`disarm` · `allow`/`revoke` (recipients, facilitators, paid services) ·
`set` (caps, rate, timeouts) · `resolve` (settle ambiguous broadcasts) ·
`identity create` · `export-key` · `backup`/`restore`. Run `peculium help` for
syntax; `doctor` is scriptable (exit code = failed checks).

## Non-goals (v1)

Remote/hosted agents, value-based caps, multi-sig identities, DEX conversions,
VerusPay invoices, mainnet. The security model is covered above; deeper design
and threat-model notes are maintained privately.

Apache-2.0.
