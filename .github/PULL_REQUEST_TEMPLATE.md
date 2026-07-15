<!--
Title MUST be a Conventional Commit — it drives semantic-release + the changelog.
  feat: …  (minor)   fix: …  (patch)   perf: …  (patch)
  feat!: … or a `BREAKING CHANGE:` footer  (major)
  docs|test|refactor|chore|ci|build: …  (no release)
Do NOT bump `version` or edit `CHANGELOG.md` by hand — the release pipeline owns both.
-->

## What & why

<!-- One or two sentences: what this changes and the motivation. -->

## Money & safety (load-bearing — this is a wallet)

- [ ] **Testnet only.** Nothing in this change relaxes the mainnet (VRSC) refusal; VRSCTEST stays the only allowed network.
- [ ] All amounts are `bigint` satoshis. No `number` for money, no `.toString()`/`Number()` shims across the `@chainvue/verus-sdk` boundary.
- [ ] **Fail-closed** preserved: hard caps + per-currency policy caps, append-only crash-safe ledger + audit trail, idempotent `requestId`s. Over-budget / over-cap offers are denied, never paid.
- [ ] **Human confirmation** is still mandatory for sends (MCP elicitation); a missing confirmation fails closed.
- [ ] Ambiguous-broadcast discipline intact: only the broadcast step may end `UNCERTAIN`; everything before it is a proven no-op.
- [ ] No real keys or `.env` are read, logged, or printed. The WIF is decrypted at spend time, used once, dereferenced.

## Spend-path / policy changes

<!-- Delete if N/A. -->
- [ ] A red test on the spend path is treated as a money bug, not a flake.
- [ ] Auth / keystore / policy / ledger changes were checked against the security model in the README before editing.
- [ ] On-chain control re-verification (identity mode) still runs at every spend.

## Checklist

- [ ] Gate green in order: `pnpm build` (tsc) → `pnpm typecheck` → `pnpm lint` → `pnpm test` (the 379-test suite).
- [ ] New/changed behavior has a test; safety-critical paths (caps, confirmation, ledger, idempotency) have explicit coverage.
- [ ] Conventional-Commit PR title; no manual `version`/`CHANGELOG.md` edits.

## Notes for reviewers

<!-- Risks, follow-ups, live/daemon-gated paths, deliberate scope limits. -->
