# Peculium

**The safe way to give an AI agent money.** Peculium is a Verus wallet for
AI agents: an MCP server the agent operates within strict, human-configured
limits, plus a CLI only the human uses to set those limits.

> Roman law's *peculium*: property entrusted to a dependent to trade with —
> ownership retained, liability capped, withdrawable at any time.

Status: **pre-release.** Testnet (VRSCTEST) only — mainnet is refused in
code, not in configuration. Do not point it at funds you care about.

## Security model — read this first

**The LLM is untrusted input.** Every design decision follows from that:

- The agent gets **eleven narrow tools** (balance, receive address, list
  recipients, prepaid balance, spending report, financial position,
  precheck, topup, send, paid fetch, transaction status). There is no tool
  that changes policy, adds a recipient, raises a cap, or touches a key —
  those are CLI-only, human-only.
- **Recipients are names, never addresses.** The agent names an allowlist
  entry; the wallet resolves and re-validates it against the current
  policy. Prompt-injected addresses have nowhere to go. The same holds for
  paid APIs: the agent names an allowlisted **service**, never a URL.
- **Sends always require human confirmation** (MCP elicitation, Claude
  Code >= 2.1.76). Topups may auto-approve only inside a facilitator's own
  budget. Hosts without elicitation **fail closed** — deny, never
  auto-approve.
- **Paid API calls are price-capped by the wallet itself.** `wallet_paid_fetch`
  preflights the endpoint unpaid, reads the v402 price offer, and only signs
  a payment if the price is within the service's per-call cap AND its
  remaining daily budget — over-budget offers are denied, never paid. Offer
  claims that could redirect the payment (network, currency, domain,
  facilitator) are pinned to operator-configured values.
- **Caps are enforced twice**: per-currency policy caps (per-tx,
  trailing-24h, lifetime — a currency without a cap entry is unspendable),
  and compiled-in hard caps that a hand-edited `policy.json` cannot widen.
- **Append-only money memory**: every attempt — including denials — lands
  in a crash-safe ledger + audit trail (`peculium history`). Anything that
  MIGHT have moved money counts against the caps until proven otherwise.
- **Lite architecture**: local offline signing (scrypt+AES-256-GCM
  keystore) + public Verus nodes. No daemon, no chain sync, no wallet RPC.
- **Identity mode**: the agent's funds can be held BY its VerusID; control
  is re-verified on-chain at every spend, so a **revocation from your cold
  wallet stops spending immediately** and a recovered identity refuses the
  old key.

**Honest limits** (the threat model in one paragraph): the spending key
lives in the wallet process. A fully compromised host = key exfiltrated =
the hot balance is gone; caps bound *accidents and prompt injection*, not
host compromise. A lying public node cannot steal (signing is local) but
can misreport balances or censor broadcasts. **Hot-wallet discipline is the
real loss bound: fund the agent only with what you would lose to
autonomy.** A VerusID adds revocation/recovery for the *identity* (see
[docs/IDENTITY-RUNBOOK.md](./docs/IDENTITY-RUNBOOK.md)); it cannot claw
back spent funds.

## Quickstart

```bash
# 1. provision a wallet (fresh key, tiny caps, VRSCTEST)
npx @chainvue/peculium-wallet init --starter

# 2. fund the printed address (faucet: https://faucet.verus.services)

# 3. check everything
npx @chainvue/peculium-wallet doctor

# 4. add the printed block to your MCP host config, with your passphrase in
#    PECULIUM_KEYSTORE_PASSPHRASE, and restart the host

# 5. allow a recipient (the agent can only use names you allowlist)
npx @chainvue/peculium-wallet allow recipient alice RBob…
```

The agent can now `wallet_precheck` / `wallet_send` — every send pops a
confirmation dialog on YOUR screen with the exact amount, recipient and
remaining budget. `peculium history` shows everything it tried.

## MCP tools (the agent's entire world)

| Tool | Gate |
|---|---|
| `wallet_balance`, `wallet_receive_address`, `wallet_list_recipients` | read-only |
| `wallet_prepaid_balance` | read-only — signed balance query at a v402 facilitator |
| `wallet_spending_report`, `wallet_financial_position` | read-only — ledger aggregates, cockpit + runway |
| `wallet_precheck` | dry-run — never reserves, never spends |
| `wallet_transaction_status` | read-only + confirmation refresh |
| `wallet_topup_facilitator` | full gate; may auto-approve within the facilitator budget |
| `wallet_send` | full gate; always human-confirmed |
| `wallet_paid_fetch` | payment gate; pays a v402 API call from prepaid credit, price-capped per call and per day |

## CLI (the human's controls)

`init` · `status` · `history` · `doctor` · `grant` (session budget) ·
`arm`/`disarm` · `allow`/`revoke` (recipients, facilitators & paid
services) · `set` (caps, rate, timeouts) · `resolve` (settle ambiguous
broadcasts and payments, repair a torn ledger tail) · `identity create`
(daemon-free VerusID registration) · `export-key` · `backup`/`restore`
(one encrypted archive).

Run `peculium help` for the full syntax.

## Operational notes

- "Daily" caps are a **trailing 24h window**, not a calendar day.
- Caps are **amounts, not value** — for volatile PBaaS tokens, review caps
  yourself; the code cannot know a token's worth.
- Protect the config dir: add a deny rule for `~/.peculium` to your MCP
  host's file permissions, so the host's own file tools cannot edit the
  policy the wallet enforces. The compiled hard caps bound the damage
  either way.
- `peculium doctor` is scriptable: exit code = number of failed checks.

## Explicit v1 non-goals

Remote/hosted agents (stdio only — where the key lives is a different
trust model), value-based caps, multi-signature identities, DEX
conversions, VerusPay invoices, mainnet. The v2 hardening step is a local
signer daemon that moves the key out of the LLM-adjacent process entirely.

Design analysis and threat model: [DESIGN.md](./DESIGN.md) · decision log:
[RISKS.md](./RISKS.md) · ecosystem strategy: [ECOSYSTEM.md](./ECOSYSTEM.md)
· identity lifecycle: [docs/IDENTITY-RUNBOOK.md](./docs/IDENTITY-RUNBOOK.md).

License: Apache-2.0.
