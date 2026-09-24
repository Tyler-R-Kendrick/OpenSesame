# scripts/

The implementations behind `pnpm <task>`. Run them through the `package.json`
script rather than directly, so the environment and arguments match what CI
and the hooks use. Pure logic lives in [`lib/`](lib) with Vitest tests beside
it (`pnpm quality:test`); the entry points here stay thin.

## Quality gates — `pnpm quality`, `pnpm lint`

| Script | Task | Checks |
|---|---|---|
| `quality-gate.mjs` | `quality:gate` | File size (400 lines) and complexity, ratcheted against [`tools/quality/quality-baseline.json`](../tools/quality/quality-baseline.json). `--update` tightens the ledger. |
| `package-metrics-gate.mjs` | `quality:packages` | Dependency cycles, phantom dependencies, stable-dependencies and reuse debt across packages and crates. |
| `app-core-boundary.mjs` | `quality:app-core` | `app-core` / `vault-core` reach into no app, platform global or cycle ([ADR 0133](../docs/adr/0133-shared-app-core.md)). |
| `bundle-budget-gate.mjs` | `quality:bundle` | Built bundle sizes against [`tools/quality/bundle-budgets.json`](../tools/quality/bundle-budgets.json). |
| `lint-changed.mjs` | `lint` | Biome over files changed since `origin/main`. |
| `design-lint.mjs` | `lint:design` | Word-verb buttons, status pills and explainer captions ([docs/design/controls.md](../docs/design/controls.md)). |
| `docs-index.mjs` | `docs:index` | Regenerates the ADR and security-audit indexes; `--check` fails when they are stale. |
| `ts-coverage-gate.mjs` | `test:coverage:ts` | TypeScript coverage floors, per package and overall. |

## Security audits — `pnpm audit:*`

One `*-gate.sh` per scanner: `cve-lite`, `ast-grep-security`, `clippy`,
`osv-scanner`, `cargo-audit`, `gitleaks`, `semgrep`, `deepsec`, `daemon-deps`
(the daemon's dependency budget), `kani` (bounded proofs), `miri` (undefined
behaviour), `shuttle` (concurrency), and `fuzz-pr-gate.sh` / `fuzz-batch.sh` /
`jazzer-gate.sh` for fuzzing. Each writes its report under `artifacts/`
(gitignored). What each tool covers and why it was chosen:
[docs/security/tooling-evaluation.md](../docs/security/tooling-evaluation.md).

## Integration and end-to-end suites

| Script | Task | Runs |
|---|---|---|
| `battle-test.sh` | part of `verify` | The cross-plane battle test. |
| `task-security-battle-test.sh` | `test:task-access` | Task-access engine under attack scenarios. |
| `nats-dogfood-test.sh` | `test:nats-dogfood` | TaskBus against a real `nats-server`. |
| `live-stack-test.sh` | `test:live-stack` | Live OpenFGA, OpenBao and gateway (start them with `start-native-deps.sh`). |
| `mtls-test.sh`, `mtls-integration-test.sh`, `mtls-browser-test.mjs`, `mtls-fixtures.sh` | `test:mtls*` | Optional mTLS: contract suites, pinned third-party fixtures, browser client certificates. |
| `authority-fabric-gate.mjs` | `test:authority-fabric` | The general-authority scenario matrix across both planes. |
| `wallet/` | `wallet:*` | Wallet spending authority: domain, contracts, protocols, browser, security, evidence. |
| `verify-sops-*.mjs`, `sops-evidence.mjs` | — | SOPS wire compatibility and its evidence bundle. |
| `verify-key-protection.mjs` | — | Vault key-protection gate. |
| `env-spec-dev-smoke.sh`, `wasm-client-core-smoke.sh` | — | Smoke tests for env-spec resolution and the Wasm client core. |
| `validate-*.sh` | — | Prerequisite checks for GitHub-backed history and Tailscale pairing. |

## Release, CI and development helpers

| Script | Used by |
|---|---|
| `check-pr-signatures.mjs` | CI: every commit on a pull request is signed. |
| `pages-release.mjs` | Deploy Pages: stamps `release.json` and verifies the live site serves that exact build. |
| `deploy-pages.sh` | Manual fallback publisher for Pages. |
| `pages-dev.sh` | `pnpm --filter @opensesame/pages dev`: the app with Host, Identity and mock IdP behind it. |
| `connect-dev-proxy.mjs` | Local HTTPS front door for Connect OAuth callbacks. |
| `setup-hooks.sh` | `pnpm setup:hooks`: points git at [`.githooks/`](../.githooks). |
| `pin-marketplace.mjs` | Re-pins the SHA-256 of every item type in [`.opensesame/marketplace.json`](../.opensesame/marketplace.json). |
| `rust-lint-contract-test.sh` | `test:rust-lint`: the rustfmt/Clippy wiring itself. |
