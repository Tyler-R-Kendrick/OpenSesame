# scripts/

The implementations behind `pnpm <task>`, grouped by what they guard. Run them
through the `package.json` script rather than directly, so the environment and
arguments match what CI and the hooks use. Every entry point finds the
repository root from its own location, so each one also works from any
working directory.

| Folder | What lives there | Run by |
|---|---|---|
| [`quality/`](quality) | Structural gates and linters | `pnpm quality`, `pnpm lint`, `pnpm lint:design`, `pnpm docs:index` |
| [`audit/`](audit) | One gate per security scanner or proof tool | `pnpm audit:*` |
| [`fuzz/`](fuzz) | cargo-fuzz and Jazzer.js passes | `pnpm audit:fuzz*`, `pnpm test:fuzz*` |
| [`test/`](test) | Cross-cutting suites, smoke tests and evidence gates | `pnpm test:*`, `pnpm verify:*`, `pnpm verify` |
| [`mtls/`](mtls) | The optional-mTLS suites and their pinned fixtures | `pnpm test:mtls*` |
| [`wallet/`](wallet) | Wallet spending-authority harness ([README](wallet/README.md)) | `pnpm wallet:*` |
| [`release/`](release) | Pages release, commit-signature check, marketplace pins | CI, Deploy Pages |
| [`dev/`](dev) | Local development launchers and git hook setup | `pnpm setup:hooks`, `pnpm --filter @opensesame/pages dev` |
| [`lib/`](lib) | Pure logic shared by the entry points, with Vitest tests beside it | `pnpm quality:test` |

Keep an entry point thin: parse arguments, call into `lib/`, set the exit
code. Logic that deserves a test goes in `lib/`, where `pnpm quality:test`
runs it.

## quality/ — `pnpm quality`, `pnpm lint`

| Script | Task | Checks |
|---|---|---|
| `quality-gate.mjs` | `quality:gate` | File size (400 lines) and complexity, ratcheted against [`tools/quality/quality-baseline.json`](../tools/quality/quality-baseline.json). `--update` tightens the ledger. |
| `package-metrics-gate.mjs` | `quality:packages` | Dependency cycles, phantom dependencies, stable-dependencies and reuse debt across packages and crates. |
| `app-core-boundary.mjs` | `quality:app-core` | `app-core` / `vault-core` reach into no app, platform global or cycle ([ADR 0133](../docs/adr/0133-shared-app-core.md)). |
| `bundle-budget-gate.mjs` | `quality:bundle` | Built bundle sizes against [`tools/quality/bundle-budgets.json`](../tools/quality/bundle-budgets.json). |
| `ts-coverage-gate.mjs` | `test:coverage:ts` | TypeScript coverage floors, per package and overall. |
| `lint-changed.mjs` | `lint` | Biome over files changed since `origin/main`. |
| `design-lint.mjs` (+ `-layout`, `-verbs`) | `lint:design` | Word-verb buttons, status pills and explainer captions ([docs/design/controls.md](../docs/design/controls.md)). |
| `docs-index.mjs` | `docs:index` | Regenerates the ADR and security-audit indexes; `--check` fails when they are stale. |

## audit/ — `pnpm audit:*`

One `*-gate.sh` per tool: `cve-lite`, `ast-grep-security`, `clippy`,
`osv-scanner`, `cargo-audit`, `gitleaks`, `semgrep`, `deepsec`, `daemon-deps`
(the daemon's dependency budget), `kani` (bounded proofs), `miri` (undefined
behaviour) and `shuttle` (concurrency). Each writes its report under
`artifacts/` (gitignored). What each tool covers and why it was chosen:
[docs/security/tooling-evaluation.md](../docs/security/tooling-evaluation.md).

## fuzz/

| Script | Task | Runs |
|---|---|---|
| `fuzz-pr-gate.sh` | `audit:fuzz` | Short cargo-fuzz pass over [`tests/fuzz/cargo`](../tests/fuzz/cargo). |
| `fuzz-batch.sh` | `audit:fuzz:batch` | Long cargo-fuzz batch over every target. |
| `jazzer-gate.sh` | `test:fuzz`, `test:fuzz:batch` | Jazzer.js over [`tests/fuzz/jazzer`](../tests/fuzz/jazzer). |

## test/

| Script | Task | Runs |
|---|---|---|
| `battle-test.sh` | part of `verify` | The cross-plane battle test. |
| `task-security-battle-test.sh` | `test:task-access` | Task-access engine under attack scenarios. |
| `nats-dogfood-test.sh` | `test:nats-dogfood` | TaskBus against a real `nats-server`. |
| `live-stack-test.sh` | `test:live-stack` | Live OpenFGA, OpenBao and gateway (start them with `dev/start-native-deps.sh`). |
| `authority-fabric-gate.mjs` | `test:authority-fabric` | The general-authority scenario matrix across both planes. |
| `rust-lint-contract-test.sh` | `test:rust-lint` | The rustfmt/Clippy wiring itself. |
| `verify-key-protection.mjs` | `verify:key-protection` | Vault key-protection gate. |
| `verify-sops-*.mjs` | `verify:sops-*` | SOPS wire compatibility: browser, conformance vectors, live cloud KMS. |
| `sops-evidence.mjs` | — | Merges the three SOPS gates' results into their evidence bundle. |
| `env-spec-dev-smoke.sh`, `wasm-client-core-smoke.sh` | — | Smoke tests for env-spec resolution and the Wasm client core (the second runs inside `battle-test.sh`). |

## mtls/ — `pnpm test:mtls*`

| Script | Task | Runs |
|---|---|---|
| `mtls-test.sh` | `test:mtls` | Native transport-security and TypeScript contract suites; no fixtures. |
| `mtls-integration-test.sh` | `test:mtls:integration` | Against pinned `nats-server`, OpenBao, SPIRE and Caddy; fails, never skips, when a fixture is missing. |
| `mtls-browser-test.mjs` | `test:mtls:browser` | Playwright client certificates against the ingress reference. |
| `mtls-fixtures.sh` | `test:mtls:fixtures` | Fetches and sha256-verifies the fixtures under `.cache/mtls-fixtures/`. |
| `mtls-static-imports.mjs`, `mtls-required-packages.txt` | inside `mtls-test.sh` | No browser package imports `node:tls`; the packages every mTLS run must cover. |

## release/

| Script | Used by |
|---|---|
| `check-pr-signatures.mjs` | CI: every commit on a pull request is signed. |
| `pages-release.mjs` | Deploy Pages: stamps `release.json` and verifies the live site serves that exact build. |
| `deploy-pages.sh` | Manual fallback publisher for Pages. |
| `pin-marketplace.mjs` | Re-pins the SHA-256 of every item type in [`.opensesame/marketplace.json`](../.opensesame/marketplace.json). |

## dev/

| Script | Used by |
|---|---|
| `setup-hooks.sh` | `pnpm setup:hooks`: points git at [`.githooks/`](../.githooks). |
| `pages-dev.sh` | `pnpm --filter @opensesame/pages dev`: the app with Host, Identity and mock IdP behind it. |
| `start-native-deps.sh` | User-space OpenFGA and OpenBao for `test:live-stack`, no root. |
| `connect-dev-proxy.mjs` | Local HTTPS front door for Connect OAuth callbacks ([the app's relay](../apps/pages/server/README.md)). |
| `validate-tailscale-pairing.sh` | Checks a running daemon's health report for Tailscale Serve pairing prerequisites. |

## Adding a script

Put it in the folder for what it guards, derive the repository root from its
own path (`$(dirname "$0")/../..` in shell, `resolve(dirname(fileURLToPath(import.meta.url)), "../..")`
in Node), give it a `package.json` task, and add a row above.
