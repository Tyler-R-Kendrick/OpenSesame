# scripts/

The implementations behind `pnpm <task>`, grouped by what they guard. Run them
through the `package.json` script rather than directly, so the environment and
arguments match what CI and the hooks use. Entry points find the repository
root from their own location, so they also work from any working directory
(`test/2password-parity-native-build.sh` is the exception and assumes the
repository root).

| Folder | What lives there | Run by |
|---|---|---|
| [`quality/`](quality) | Structural gates and linters | `pnpm quality`, `pnpm lint`, `pnpm lint:design`, `pnpm lint:anti-slop`, `pnpm docs:index` |
| [`audit/`](audit) | One gate per security scanner or proof tool | `pnpm audit:*` |
| [`fuzz/`](fuzz) | cargo-fuzz and Jazzer.js passes | `pnpm audit:fuzz*`, `pnpm test:fuzz*` |
| [`test/`](test) | Cross-cutting suites, smoke tests and evidence gates | `pnpm test:*`, `pnpm verify:*`, `pnpm verify` |
| [`mtls/`](mtls) | The optional-mTLS suites and their pinned fixtures | `pnpm test:mtls*` |
| [`wallet/`](wallet) | Wallet spending-authority harness ([README](wallet/README.md)) | `pnpm wallet:*` |
| [`release/`](release) | Pages release, commit-signature check, signed-stack replay, connector and marketplace pins | CI, Deploy Pages, a terminal ([README](release/README.md)) |
| [`dev/`](dev) | Local development launchers and git hook setup | `pnpm dev:cli`, `dev:host`, `dev:daemon`, `dev:live-nats`, `pnpm setup:hooks`, `pnpm --filter @opensesame/pages dev` |
| [`security/`](security) | The dependency-backport ledger and regression tests for patched and upgraded dependencies | `pnpm audit:osv`, `pnpm quality:test` |
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
| `log-hygiene-gate.mjs` | `quality:log-hygiene` | `console.*`, hand-built `pino(...)`, direct stdout/stderr writes and tracing subscribers without the scrubbing writer, ratcheted against [`tools/quality/log-hygiene-baseline.json`](../tools/quality/log-hygiene-baseline.json) ([ADR 0157](../docs/adr/0157-logs-and-events-carry-no-secrets.md)). |
| `anti-slop-gate.mjs` | `lint:anti-slop` | Strict Oxlint anti-slop over the repository, ratcheted against [`tools/quality/anti-slop-baseline.json`](../tools/quality/anti-slop-baseline.json); an unused disable directive always fails. |
| `bundle-budget-gate.mjs` | `quality:bundle` | Built bundle sizes against [`tools/quality/bundle-budgets.json`](../tools/quality/bundle-budgets.json). |
| `ts-coverage-gate.mjs` | `test:coverage:ts` | TypeScript coverage floors, per package and overall. |
| `lint-changed.mjs` | `lint` | Biome over files changed since `origin/main`. |
| `design-lint.mjs` (+ `design-lint-{copy,corners,failures,hints,ink,layout,sheets,verbs}.mjs`, `prose-lint.mjs`) | `lint:design` | Word-verb buttons, status pills, explainer captions, in-page failure boxes, round corners, red control ink, confirmation-sheet shapes, key placement and field widths ([docs/design/controls.md](../docs/design/controls.md)). |
| `docs-index.mjs` | `docs:index` | Regenerates the ADR, security-audit and evidence indexes; `--check` fails when they are stale. |

## audit/ — `pnpm audit:*`

One `*-gate.sh` per tool: `cve-lite`, `ast-grep-security`, `clippy`,
`osv-scanner`, `cargo-audit`, `gitleaks`, `semgrep`, `deepsec`, `daemon-deps`
(the daemon's dependency budget), `plugin-boundary` (the default binary and the
daemon reach no plugin crate), `kani` (bounded proofs), `miri` (undefined
behaviour) and `shuttle` (concurrency). The gates that produce a report
(`cve-lite`, `ast-grep-security`, `clippy`, `osv-scanner`, `cargo-audit`,
`gitleaks`, `semgrep`) write it to a fresh private directory outside the
checkout (`OPENSESAME_AUDIT_DIR`, default under `$TMPDIR`) and print its path;
the others report on the terminal (`deepsec` keeps its state under
`.deepsec/`). What each tool covers and why it was chosen:
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
| `live-fixtures.sh` | `test:live-fixtures` | The nats-server pin, an ntfy built from pinned upstream source, and `live-turn` (`scripts/test/live-turn`, pion/turn over UDP, TCP and TLS), for `verify:live-join`'s carriers and TURN walks. |
| `connect-preflight.mjs` | `test:connect-preflight` | Every connector's real endpoints, read-only: OAuth authorize and discovery, MCP metadata, API-key verify ([ADR 0147](../docs/adr/0147-connector-plans-and-user-token-proof.md)). Logic in `lib/connect-preflight.mjs`. |
| `live-stack-test.sh` | `test:live-stack` | Live OpenFGA, OpenBao and gateway (start them with `dev/start-native-deps.sh`). |
| `authority-fabric-gate.mjs` | `test:authority-fabric` | The general-authority verification gate: resolves every scenario in the registry against what is wired, runs the tests that exist and writes its report under `docs/evidence/general-authority/`. |
| `bitwarden-oracle-test.sh` (+ `bitwarden-hub-client.mjs`) | `test:bitwarden-oracle` | The pinned official `bw` CLI and SignalR client against the `bitwarden-compat` surface ([ADR 0141](../docs/adr/0141-bitwarden-compatible-server.md)); fails, never skips. |
| `2password-parity.mjs` (+ `2password-*.test.ts`) | `test:2password-parity` | Rebuilds and exercises every contract declared in `spec/conformance/2password-parity.json`. |
| `plugin-boundary-negative-control.sh` | `test:plugin-boundary` | Points `audit/plugin-boundary-gate.sh` at the plugin crate itself; the gate must fail. |
| `tailnet-sync-real-tailnet.sh` | `test:tailnet-sync:real` | Tailnet vault sync over a real tailnet ([ADR 0144](../docs/adr/0144-tailnet-vault-sync.md)). |
| `mobile-android.sh`, `mobile-android-apk.sh`, `mobile-apple.sh`, `mobile-changed.sh` | — | The native mobile checks CI runs: JVM crypto/FFI tests and an Android build, the assembled APK, Swift crypto tests, and whether a diff reaches them. |
| `rust-lint-contract-test.sh` | `test:rust-lint` | The rustfmt/Clippy wiring itself. |
| `verify-key-protection.mjs` | `verify:key-protection` | Vault key-protection gate. |
| `verify-customer-vault-browser.mjs` (+ `customer-*-browser-checks.mjs`) | `verify:customer-vault-browser` | Real-Chromium WebCrypto and OPFS regression for customer vault segmentation. |
| `customer-sdk-live.mts` | — | Live public-SDK regression; needs a loopback Host fixture and its synthetic operator token. |
| `verify-sops-*.mjs` | `verify:sops-*` | SOPS wire compatibility: browser, conformance vectors, live cloud KMS. |
| `sops-evidence.mjs` | — | Merges the three SOPS gates' results into their evidence bundle. |
| `pepper-position-reference.py` | — | Writes `spec/conformance/pepper-position-vectors.json` from Python's own slicing; `--check` only compares the file on disk ([ADR 0174](../docs/adr/0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)). |
| `env-spec-dev-smoke.sh`, `wasm-client-core-smoke.sh` | — | Smoke tests for env-spec resolution and the Wasm client core (the second runs inside `battle-test.sh`). |

## mtls/ — `pnpm test:mtls*`

| Script | Task | Runs |
|---|---|---|
| `mtls-test.sh` | `test:mtls` | Native transport-security and TypeScript contract suites; no fixtures. |
| `mtls-integration-test.sh` | `test:mtls:integration` | Against pinned `nats-server`, OpenBao, SPIRE and Caddy; fails, never skips, when a fixture is missing. |
| `mtls-browser-test.mjs` | `test:mtls:browser` | Playwright client certificates against the Identity API's TLS listener, plus the static origin and the Transport page with no certificate. |
| `mtls-fixtures.sh` | `test:mtls:fixtures` | Fetches and sha256-verifies the fixtures under `.cache/mtls-fixtures/`. |
| `mtls-static-imports.mjs`, `mtls-required-packages.txt` | inside `mtls-test.sh` (the list also gates `mtls-integration-test.sh`) | No browser package imports `node:tls`; the packages every mTLS run must cover. |

## release/

| Script | Used by |
|---|---|
| `check-pr-signatures.mjs` | CI: every commit on a pull request is signed. |
| `pages-release.mjs` | Deploy Pages: stamps `release.json` and verifies the live site serves that exact build. |
| `deploy-pages.sh` | Manual fallback publisher for Pages. |
| `pin-connect-services.mjs` | Re-pins [`spec/connectors/connect-services.json`](../spec/connectors/connect-services.json): Vercel Connect's public service registry and each MCP server's live OAuth discovery (`lib/oauth-discovery.mjs`). |
| `pin-marketplace.mjs` | Re-pins the SHA-256 of every item type in [`.opensesame/marketplace.json`](../.opensesame/marketplace.json). |
| `land-signed-stack.mjs` | Replays a local branch stack as GitHub-verified commits ([README](release/README.md)). |

## dev/

| Script | Used by |
|---|---|
| `setup-hooks.sh` | `pnpm setup:hooks`: points git at [`.githooks/`](../.githooks). |
| `dev-cli.sh`, `dev-host.sh`, `dev-daemon.sh` | `pnpm dev:cli`, `pnpm dev:host`, `pnpm dev:daemon`: the native CLI, the Host API and the daemon from source, after sourcing `local-env.sh`. |
| `local-env.sh` | Sourced by the three launchers above: the development environment they share. |
| `pages-dev.sh` | `pnpm --filter @opensesame/pages dev`: the app with Host, Identity and mock IdP behind it. |
| `start-native-deps.sh` | User-space OpenFGA and OpenBao for `test:live-stack`, no root. |
| `connect-dev-proxy.mjs` | Local HTTPS front door for Connect OAuth callbacks ([the app's relay](../apps/pages/server/README.md)). |
| `validate-tailscale-pairing.sh` | Checks a running daemon's health report for Tailscale Serve pairing prerequisites. |
| `live-nats-operator.ts` | `pnpm dev:live-nats`: a nats-server configuration in operator mode whose credentials live sessions mint, and the account signing key for Routes ([ADR 0167](../docs/adr/0167-nats-live-session-route.md)). |

## security/

| File | Used by |
|---|---|
| `verified-backports.mjs`, `dependency-backports.json` | `audit:osv`: an npm finding for `braces` or `node-forge` counts as remediated only when the lockfile binding, the patch in [`patches/`](../patches) and the installed sources all match the recorded advisory, version and SHA-256s. |
| `*.test.mjs` | `quality:test` (`node --test scripts/security/*.test.mjs`): attack regressions for the backports and the `js-yaml`, `shell-quote`/`source-map-js` and `simple-git` upgrades ([`patches/simple-git-parser-residual.md`](../patches/simple-git-parser-residual.md)). |

## Adding a script

Put it in the folder for what it guards, derive the repository root from its
own path (`$(dirname "$0")/../..` in shell, `resolve(dirname(fileURLToPath(import.meta.url)), "../..")`
in Node), give it a `package.json` task, and add a row above.
