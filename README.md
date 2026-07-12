# Peculium

**The safe way to give an AI agent money.** Peculium is a Verus wallet for
AI agents: an MCP server the agent operates within strict, human-configured
limits, plus a CLI only the human uses to set those limits.

> Roman law's *peculium*: property entrusted to a dependent to trade with —
> ownership retained, liability capped, withdrawable at any time.

Status: **pre-release, under construction.** Testnet (VRSCTEST) only.
Nothing here is production-ready; do not point it at funds you care about.

## How it's shaped (the short version)

- **The LLM is untrusted input.** The agent gets six narrow tools (check
  balance, list allowed recipients, top up a whitelisted facilitator, send
  to a whitelisted recipient, precheck, transaction status). There is no
  tool that changes policy, adds a recipient, raises a cap, or touches a
  key — those are CLI-only, human-only.
- **Lite architecture, zero infrastructure:** local offline signing
  (encrypted keystore) + public Verus nodes. No daemon, no chain sync.
- **Everything auditable:** append-only spend ledger + audit trail
  (`peculium history`) — including what the agent *tried* and was denied.
- **Human confirmation** for anything outside the pre-approved envelope,
  via MCP elicitation (Claude Code ≥ 2.1.76); hosts without it fail
  closed.
- **Hot-wallet discipline is the real loss bound**: fund the agent only
  with what you would lose to autonomy.

Design analysis and threat model: [DESIGN.md](./DESIGN.md) · decision log:
[RISKS.md](./RISKS.md) · ecosystem strategy: [ECOSYSTEM.md](./ECOSYSTEM.md).

License: Apache-2.0.
