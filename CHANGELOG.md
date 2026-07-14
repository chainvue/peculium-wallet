# Changelog

## 0.2.0 (2026-07-14) — wallet_paid_fetch: one client for everything

Peculium is now the SINGLE agent-side v402 client: topup, prepaid balance
AND per-request paid API calls under one identity, one key, one policy,
one ledger. `@chainvue/v402-mcp` is no longer needed next to the wallet.

- New MCP tool `wallet_paid_fetch { requestId, service, path?, method?,
  body?, maxPrice? }`: pays an allowlisted service's v402 price per request
  from prepaid credit (an off-chain signature, not a blockchain tx). The
  wallet preflights unpaid, reads the 402 offer, and only signs if the
  price is within the service's per-call cap AND remaining daily budget —
  over-budget offers are denied, never paid. Offer claims that could
  redirect the payment (network, currency, domain, facilitator) are pinned
  to operator-configured values. Requires identity mode.
- New policy category `services` with its own compiled hard caps (per-call
  + trailing-24h, tighter in starter mode); operator CLI `peculium allow
  service <name> --origin <https://…> --facilitator <name> --max-per-call X
  --max-per-day Y [--auto-approve]` and `revoke service`. Services appear
  in `wallet_list_recipients` / status / financial position with
  `remainingToday`.
- Paid-fetch rows land in the same append-only ledger and audit trail as
  everything else (new off-chain money kind: no txid, records service,
  amount, http status, requestId) with the fail-closed ambiguity
  discipline; `peculium resolve <id> --spent` now works without a txid for
  off-chain rows (on-chain rows still require it as evidence).

## 0.1.0 (2026-07-14) — first release

The safe Verus wallet for AI agents: an MCP server the agent operates
within strict, human-configured limits, plus a CLI only the human uses.
Testnet (VRSCTEST) only — mainnet is refused in code.

- Ten MCP tools: balance, receive address, allowlists (with live remaining
  budgets), precheck (dry-run), transaction status (requestId or txid,
  staleness + credit-latency hints), spending report (chartable aggregates
  + recent requests), financial position (cockpit with burn-rate runway),
  prepaid balance at v402 facilitators (signed queries via the reference
  client), topup (auto-approve within operator budgets), send (always
  human-confirmed via MCP elicitation, fail-closed without it).
- Operator CLI: init (fresh key or adopt), status/history/report/doctor,
  grant/arm/disarm, allow/revoke (recipients & facilitators incl. apiUrl),
  set (caps/rate/timeouts), resolve (ambiguous broadcasts, torn-tail
  repair), identity create (daemon-free VerusID registration, live-proven),
  export-key, backup/restore (encrypted archives).
- Fail-closed money semantics end to end: compiled hard caps, per-currency
  policy caps (trailing-24h windows), append-only crash-safe ledger + audit
  trail, idempotent requestIds, ambiguous-outcome discipline.
- Identity mode: the agent's funds can be held BY its VerusID — control is
  re-verified on-chain at every spend, so a revocation from the cold wallet
  stops spending immediately. Live-proven on VRSCTEST including the full
  autonomous v402 topup->auto-credit loop.

Requires: Node >= 22. Uses public Verus nodes (default api.verustest.net);
no daemon, no chain sync. See README for the security model — read it first.
