# CLAUDE.md — @chainvue/peculium-wallet

The safe Verus wallet for AI agents: an MCP server the agent operates within
strict, human-configured limits, plus a CLI only the human uses. **Testnet
(VRSCTEST) only — mainnet is refused in code; never relax that.**

## Money & safety — load-bearing
- All amounts are `bigint` satoshis. Consumes `@chainvue/verus-sdk` (bigint
  money) and `@chainvue/verus-rpc`. No `number` for money, no
  `.toString()`/`Number()` shims across the SDK boundary.
- **Fail-closed everywhere**: compiled hard caps, per-currency policy caps
  (trailing-24h windows), append-only crash-safe ledger + audit trail,
  idempotent requestIds, ambiguous-broadcast discipline (only the broadcast
  step may end UNCERTAIN; everything before it is a proven no-op).
- Human confirmation is mandatory for sends (MCP elicitation); fail closed if
  it's missing. Over-budget/over-cap offers are denied, never paid.
- **Never read or print real keys or `.env`.** The WIF is decrypted at spend
  time, used once, dereferenced. The security model is in the README — read it
  before touching auth/keystore/spend paths.

## Conventions
- License **Apache-2.0**. Node ≥ 22, pnpm.
- Identity mode: agent funds may be held BY its VerusID; control is re-verified
  on-chain at every spend.

## Gate (run before claiming done, in order)
`pnpm build` (tsc) → `pnpm typecheck` → `pnpm lint` → `pnpm test` (vitest, the
379-test suite is the safety net). The suite drives real offline signing with a
mocked RPC — treat a red test on the spend path as a money bug.

## Releases — automated, do not hand-roll
Conventional Commits drive **semantic-release**. **Never hand-edit
`CHANGELOG.md` or bump `version`.** Do not `git push`, tag, or publish without
an explicit ask. This package's clean install requires `@chainvue/verus-sdk`
≥ 0.5.0 (bigint) on the registry.

## Decision log
The maintainer-facing "why" (risks, decisions) is kept **privately, outside
this repo**; `CHANGELOG.md` is the adopter-facing "what".
