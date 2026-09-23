# AGENTS.md

Agent context for OpenSesame. This file is the canonical entry point for any
coding agent working in this repo — read it before spelunking.

## 1. What this is

OpenSesame is a private **authorization fabric for the agentic era**: a
dual-plane system with a **host/client** product topology (see
[ADR 0017](docs/adr/0017-host-client-product-topology.md)).

- **Host / authority plane (Rust)** — `host-core` + Host API `apps/gateway`
  (`:8787`): ConnectionRef → authorize → invoke → receipt. Local host agent
  `apps/daemon` (`:18790`). Host CLI `apps/cli` (binary `opensesame`).
  Password-manager ecosystem bridging (KDBX, keepassxc-protocol,
  browserpass/gopass hosts, Bitwarden/Passbolt consume-clients) lives in
  `crates/kdbx-bridge`, `crates/provider-bitwarden` and the default-off
  `apps/pm-bridges` binaries — human/device/ops plane only, never
  agent-facing ([ADR 0052](docs/adr/0052-password-manager-ecosystem-bridging.md),
  [ADR 0053](docs/adr/0053-pm-bridge-binaries.md)).
- **Client plane (Rust → Wasm + TS)** — `client-core` E2EE sync +
  `packages/api-client` (Host API TS client). Browser extension
  `apps/browser-extension` (WXT), PWA `apps/pwa`, offline GitHub Pages PWA
  `apps/pages`, Client CLI `packages/cli` (binary `opensesame-id`), MCP
  servers `apps/mcp-client` / `apps/mcp-host`.
- **Identity plane (TypeScript)** — Identity API `apps/control-plane`
  (`:8788`, Hono + Better Auth + oidc-provider), mock upstream IdP
  `apps/mock-upstream-idp` (`:9090`).

Identity and Host APIs are kept **deliberately separate** — no BFF merge.
Canonical principals live in OpenSesame domain models
(`packages/os-domain`), not Better Auth user IDs.

## 2. Toolchain

- Node ≥ 22 (via `engines` in `package.json`)
- pnpm `9.15.0` via Corepack (`packageManager` field)
- Rust `1.88` pinned for the host/authority plane (`cargo +1.88.0 ...`)
- Turbo `2.9.14` (task orchestration across the workspace)
- Biome `1.9.4` (lint + format, 2-space indent)
- Oxlint `1.79.0` with vendored anti-slop (`pnpm lint:anti-slop`)
- Vitest `4.1.11` (TS unit/integration tests), Playwright `1.55.1` (e2e)

## 3. Command crib sheet

All scripts below are defined in the root `package.json` unless noted.

```bash
pnpm bootstrap           # install + db:generate + db:migrate
pnpm dev                 # turbo dev (control-plane, console, worker,
                          #   mock-upstream-idp, example-rp-alpha/beta), parallel
pnpm build               # turbo run build
pnpm typecheck           # turbo run typecheck
pnpm lint                # Biome gate for files changed from origin/main
pnpm lint:design         # control contract (docs/design/controls.md)
pnpm lint:all            # full-repository Biome + anti-slop audit
pnpm lint:anti-slop      # strict Oxlint anti-slop; nested configs/unused disables fail
pnpm quality             # structural + component-coupling gates (both ratchets)
pnpm quality:gate        # module size (400) + TS complexity; ratchets quality-baseline.json
pnpm quality:packages    # ADP cycles, phantom deps, SDP/CRP debt across both planes
pnpm quality:app-core    # shared-core gate (ADR 0133) over app-core + vault-core: no reach into an app, no React value,
                          #   no import.meta.env, no virtual module, node:* only in src/node, no browser global outside
                          #   src/browser (vault-core: none), no static import cycle, lazy-cycle ledger only shrinks
pnpm quality:bundle      # build apps/pages|pwa|console, check bundle-budgets.json
pnpm quality:report      # all three as reports, no gating
pnpm test:anti-slop      # plugin RuleTester suite + installer-asset parity
pnpm test:rust-lint      # contract test for rustfmt/Clippy hook + verify wiring
pnpm lint:fix            # fix changed and staged files
pnpm test                # turbo test across every workspace test script
pnpm test:integration    # turbo run test:integration
pnpm test:e2e            # turbo run test:e2e; live suites require their URLs
pnpm test:security       # @opensesame/testing test:security
pnpm test:task-access    # scripts/task-security-battle-test.sh
pnpm test:redteam        # @opensesame/redteam structural pact suite
pnpm test:visual         # Playwright pixel baselines (@opensesame/visual-contract)
pnpm test:nats-dogfood   # scripts/nats-dogfood-test.sh (spins up real nats-server)
pnpm test:live-stack     # scripts/live-stack-test.sh (live OpenFGA/OpenBao/gateway)
pnpm test:mtls           # scripts/mtls-test.sh — native transport-security + TS contract suites, no fixtures
pnpm test:mtls:integration # scripts/mtls-integration-test.sh — pinned nats-server / OpenBao / SPIRE / Caddy
                          #   fixtures (scripts/mtls-fixtures.sh); fails, never skips, when a fixture is absent
pnpm test:mtls:browser   # scripts/mtls-browser-test.mjs — Playwright clientCertificates against the
                          #   ingress reference, plus the static app with no certificate
pnpm test:mtls:fixtures  # scripts/mtls-fixtures.sh fetch all + verify — sha256-pinned nats-server,
                          #   OpenBao, SPIRE, Caddy under .cache/mtls-fixtures/ (never a browser dep)
pnpm test:all            # typecheck + test + test:integration

# Test-depth suites (none of these are in `pnpm verify`)
pnpm test:coverage       # TS (v8, 94/88/94/95 floors + 50% per-pkg lines) + Rust (llvm-cov) — docs/validation/test-coverage.md
pnpm test:coverage:ts    # scripts/ts-coverage-gate.mjs; floors ratchet, never lower
pnpm test:coverage:rust  # cargo llvm-cov --fail-under-lines/-functions
pnpm test:mutation       # Stryker (TS) + cargo-mutants (Rust), scoped high-value files
pnpm test:mutation:ts    # stryker run → artifacts/mutation/typescript.json
pnpm test:mutation:rust  # cargo mutants → artifacts/mutation/rust
pnpm test:fuzz:batch     # Jazzer.js long pass (FUZZ_SECONDS=300)
pnpm db:migrate          # @opensesame/database db:migrate
pnpm db:reset            # @opensesame/database db:reset
pnpm generate:openapi    # writes apps/control-plane/openapi.json
pnpm generate:sbom       # CycloneDX SBOM to sbom/bom.json
pnpm verify              # changed-file lint + anti-slop lint/plugin tests
                          #   + rustfmt/full-feature Clippy + test:all
                          #   + cargo +1.88.0 test --workspace --all-targets
                          #   + ./scripts/battle-test.sh — full local gate

# Security/audit gates (each backed by scripts/*-gate.sh)
pnpm audit:cve-lite
pnpm audit:ast-grep
pnpm audit:clippy          # rustfmt + full-feature Clippy; pedantic/complexity denied
pnpm audit:osv
pnpm audit:cargo-audit
pnpm audit:gitleaks
pnpm audit:semgrep
pnpm audit:daemon-deps      # daemon dependency budget (ADR 0048 §5)
pnpm audit:fuzz             # cargo-fuzz short pass (not in verify)
pnpm audit:fuzz:batch       # cargo-fuzz long batch over all targets (not in verify)
pnpm audit:kani             # bounded proofs (scripts/kani-gate.sh)
pnpm audit:miri             # UB checks (scripts/miri-gate.sh)
pnpm audit:shuttle          # concurrency model checks (scripts/shuttle-gate.sh)
pnpm test:fuzz              # Jazzer.js short pass (not in verify)
```

### Per-plane local run

**Identity plane:**
```bash
pnpm install
pnpm --filter @opensesame/mock-upstream-idp build
pnpm --filter @opensesame/mock-upstream-idp start        # :9090
export OPENSESAME_ENV=development                        # or OPENSESAME_ALLOW_DEV_DEFAULTS=true
pnpm --filter @opensesame/control-plane start             # :8788
curl -s http://127.0.0.1:8788/v1/health/live
```

**Host plane:**
```bash
cargo build -p opensesame-gateway -p opensesame-cli -p opensesame-daemon
./target/debug/opensesame-gateway --listen 127.0.0.1:8787
./target/debug/opensesame-daemon --listen 127.0.0.1:18790
./target/debug/opensesame daemon status
./target/debug/opensesame login --flow device --no-browser --server http://127.0.0.1:8787

# Sealed store (pass parity; never agent-facing reveal)
./target/debug/opensesame pass init --path ~/.password-store \
  --remote https://github.com/you/password-store.git   # --remote optional
./target/debug/opensesame pass insert Dev/api-token
./target/debug/opensesame pass show Dev/api-token --reveal
./target/debug/opensesame pass ls
./target/debug/opensesame pass generate Dev/new --length 32
./target/debug/opensesame pass attach add Taxes/2025 ./w2.pdf   # seal a document
./target/debug/opensesame pass attach ls                        # metadata only
./target/debug/opensesame pass attach get Taxes/2025 --reveal --out ./  # human-gated
./target/debug/opensesame pass attach gc                        # reclaim orphan chunks
./target/debug/opensesame pass attach sync --to-dir /mnt/enc          # replicate ciphertext
./target/debug/opensesame pass attach sync                              # replicate via Host target
./target/debug/opensesame pass seal manifest.json --shred  # encrypt a Pages manifest
./target/debug/opensesame pass backup                      # commit + push to origin
# backup auth for GitHub HTTPS remotes: GITHUB_TOKEN → GitHub App
# (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH) → `gh auth token`
```

**Pages (offline PWA) — local debug (attached HMR):**
When the human says run the app locally, attach a live debug session. Do
not hand off a URL, a `preview` of `dist/`, or a headless `verify:*` run.

```bash
pnpm --filter @opensesame/pages dev:web   # vite --port 5180 --strictPort --host localhost
# Keep this process attached. Open http://localhost:5180 (localhost, not
# 127.0.0.1, for passkeys). Watch console, pageerror, and failed requests.
# Patch source so Vite HMR updates the same session; do not restart from
# dist/ unless a merge-gate build was requested.
pnpm --filter @opensesame/pages dev       # full stack: gateway + Identity + mock IdPs + Vite
```

**Pages as a static front end, no backend (ADR 0090) — run before touching
sign-in, setup, settings defaults or anything on the boot path:**
```bash
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:static
# Drives dist/ under https://tyler-r-kendrick.github.io/OpenSesame/ in
# headless Chromium: first screen is sign-in + guest (no setup wall), guest
# walks every section, Google via a mocked shoo.dev lands unlocked, deep
# links resolve. Fails on any page error, console error, loopback request,
# missing asset, or on-screen "No Identity API" copy.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:mobile
# Same harness, the phone journey (DESIGN.md § Touch): 320, 390, 430 and
# landscape, in a real coarse-pointer context. Every interactive control is
# 44px, no form control is under 16px (iOS zooms a smaller one on focus and
# never zooms back), nothing floating rests on a control, the statusline is
# one row, the tab bar ends on the last pixel, the chrome stays under a third
# of the screen, and no strip hides its own selected item. Run before touching
# layout, chrome, controls or any of the CSS under `(pointer: coarse)`.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:auth
# Same harness, the authentication flow (ADR 0091): a guest presses Add on the
# authenticator row and is walked through a key first (the PIN card, in the
# same sheet), then scan, then a code computed from the setup key on screen,
# then the recovery codes; lock → only the PIN tab, code announced as step 2 →
# PIN → code → open, again after a reload; and a password-sealed vault the
# same way. Run before touching unlock methods, second steps or the unlock
# screen.
```

Sealed-store Settings bridge: export a path manifest in Pages, then
`opensesame pass seal manifest.json --shred` encrypts it into the store and
`opensesame pass backup` pushes ciphertext to the git remote. Importing a manifest
in Pages merges by store path (idempotent), never duplicates.

Server-side backup (ADR 0039): gateway-held secrets need no CLI at all —
register the GitHub App (`POST /api/v1/providers/github/app`), install it on
the org, then `PUT /api/v1/backup/target` once. Every credential/sync/vault
mutation broadcasts an outbox event; the gateway's backup actor persists a
full ciphertext snapshot to the repo with compensating retries/suspension.
## 4. Layout map

| Path | Role |
|------|------|
| `crates/core`, `crates/host-core`, `crates/client-core` | WIT/Wasm polyglot core + product-SDK facades |
| `apps/gateway` | Host API, `:8787` (`opensesame-gateway`) |
| `apps/daemon` | Local host agent, `:18790` (`opensesame-daemon`) |
| `apps/cli` | Host CLI, binary `opensesame` (`opensesame-cli`) — includes `pass` sealed-store verbs |
| `crates/storage` | SQLite-backed host store; `impl Db` is split one module per responsibility (ADR 0093) |
| `crates/sealed-store` | Git-native hierarchical sealed secret store (`pass` parity) |
| `crates/lifecycle` | Expiry ladder, subjects, and frozen hook event names — pure, value-blind (ADR 0074) |
| `crates/security-events` | Shared security-event envelope, severity ladder, and Alertmanager v2 / `PagerDuty` v2 / RFC 5424 renderers — pure, no I/O (ADR 0080) |
| `crates/breach-intel` | Value-blind breach detection: Pwned Passwords k-anonymity, public breach-catalogue matching, frozen `breach.*` events (ADR 0080) |
| `crates/agent-events` | Frozen `agent.*` vocabulary for sandboxed runs, and the `SecurityNotice` conversion that puts them on ADR 0080's feed — pure, value-blind (ADR 0081) |
| `crates/human-vault` | E2EE envelope crypto shared by vault + sealed-store |
| `crates/session-observe` | Live observation of sandboxed agent runs — one sealed log (live tails, replay seeks), fail-closed frame admission, single-holder control lease (ADR 0081) |
| `crates/ceremony` | Connector registration ceremonies — the C0..C3 tier ladder, typed capture slots that fail closed, and ADR 0082 §5's refusals as types (ADR 0082) |
| `crates/a2h` | A2H (Agent-to-Human) v1.0 client — envelope, intent mapping, callback verification; a reply may only narrow authority (ADR 0081 §10) |
| `crates/rotation-web` | Web-login rotation: the step IR, the tool boundary (no method returns a credential value), and the ordering that must not be rearranged (ADR 0076); plus the same boundary read backwards — `CeremonyTransport`'s capture verbs, which seal what a page produced and answer with a digest (ADR 0082 §3) |
| `crates/vault-item-types` | Host-plane item type parser, registry, and native-secret projection; embeds the shared definition corpus (ADR 0087) |
| `crates/connection-detect` | Value-blind, capability-moded credential discovery (ADR 0047/0048; serde+thiserror+std budget) |
| `crates/uds-authn` | UDS peer-credential attestation, same-user allowlist (ADR 0048 §8) |
| `crates/tailscale-authn` | Tailnet caller identity via tailscaled LocalAPI whois (ADR 0048 §8) |
| `crates/invoke-through` | Memory-resident invoke-through broker — egress allowlist, no redirects (ADR 0048 D6/D7) |
| `crates/transport-security` | Native TLS for the authority plane — rustls listeners/clients, `TlsIdentity` / `TrustBundle`, atomic `TransportGenerations`, SPIFFE and RFC 9525 verifiers; `testkit` feature issues disposable PKI for tests (ADR 0132) |
| `crates/domain/src/transport` | Pure transport contracts — `TransportPolicy`, `ServiceBindingSet` (default deny, exact selectors), non-deserializable `VerifiedPeer`, status views, stable error codes; TS mirror in `packages/os-domain` / `packages/contracts` (ADR 0132) |
| `crates/spiffe-source` | SPIFFE Workload API X.509-SVID source → `TransportGenerations`; exact configured SPIFFE ID, per-domain bundles, snapshot replacement; SPIRE is an optional issuer (ADR 0132 §2) |
| `crates/ingress-evidence`, `packages/ingress-evidence` | RFC 9440 `Client-Cert` / `Client-Cert-Chain` bounded parsing; accepted only from a bound ingress on a `trusted_ingress` listener (ADR 0132 §8) |
| `crates/nats-callout` | Native `$SYS.REQ.USER.AUTH` bridge (`opensesame-nats-auth-bridge`) — NKey/JWT verification, request/response binding; a high-trust component, narrowly bound to the Host (ADR 0132 §8) |
| `apps/gateway/src/transport` | Host transport runtime — config, admission (`ServiceCallerExtractor`), bindings CAS, status, verify probe, trust/lifecycle routes under `/api/v1/operator/transport/*` (ADR 0132) |
| `ops/ingress`, `ops/nats` | Vendor-neutral reference configurations — Caddy trusted ingress; NATS client-mTLS (`verify`) and certificate-mapping (`verify_and_map`) profiles plus the one tested server-to-server topology (ADR 0132 §8) |
| `tests/mtls-interop` | Real-protocol interop crate (`opensesame-mtls-interop`): Rust↔Node listeners, nats-server, OpenBao `auth/cert`, SPIRE, ingress; `#[ignore]`d unless `OPENSESAME_MTLS_FIXTURES=1` |
| `apps/credential-helpers` | git/docker/AWS/kubectl helper bins — thin mint-path clients of the daemon (ADR 0049) |
| `crates/kdbx-bridge` | KDBX 4.x read/write + mapping to sealed-store `Entry` (ADR 0052; not a daemon dep) |
| `crates/provider-bitwarden` | Bitwarden/vaultwarden consume-client — memory-resident session, host+TLS pinned (ADR 0052; not a daemon dep) |
| `apps/pm-bridges` | Local-IPC serving bins (keepassxc-protocol, browserpass, gopass, Secret Service) — per-surface cargo features, all default off (ADR 0052/0053) |
| `apps/toolbar` | Daemon control stub (`opensesame-toolbar`) |
| `apps/credential-agent` | Legacy credential agent (`opensesame-credential-agent`) |
| `apps/callback-edge` | Edge callback service (`opensesame-callback-edge`) |
| `apps/control-plane` | Identity API, `:8788` (Hono + Better Auth + oidc-provider) |
| `apps/mock-upstream-idp` | Deterministic mock OIDC upstream for local dev, `:9090` |
| `apps/pwa` / `apps/mobile-mfa` | Client PWA + step-up MFA UX (against `:8788`) |
| `apps/pages` | Installable GitHub Pages offline PWA — the React shell over `@opensesame/app-core`: screens, sections, components, React bindings (`src/bindings/`), DOM/keyboard helpers, the service worker and the capability build (`src/lib/capabilities/{ownership,classification*,module-table,distribution}.ts`) |
| `apps/pages/src/tutorial`, `packages/app-core/src/tutorial` | In-product contextual support (ADR 0088): the semantic target/route/predicate registries and the on-device and AG-UI transports live in the core; the Driver.js renderer and the support panel stay in the shell |
| `packages/app-core/src/lib/nango-directory.ts`, `packages/app-core/src/lib/connector-directory.ts` | Connectors by reference: the Nango-compatible listing adapter (two routes, never a credential) and the directory's three homes — plaintext endpoint, sealed key + list, in-memory until a vault seals it (ADR 0115) |
| `apps/mcp-client` / `apps/mcp-host` | MCP servers (client- and host-facing) |
| `apps/console` | Vite Identity console (web UI) |
| `apps/worker` | Background worker |
| `apps/browser-extension` | WXT browser extension |
| `apps/example-rp-alpha` / `apps/example-rp-beta` | Example relying-party apps |
| `apps/example-agent` / `apps/example-headless` | Example agent / headless client |
| `packages/app-core` | The client application core shared by the Pages PWA, the CLIs and Android (ADR 0133): the vault store and its tombs, identity and federation, browser-local IAM, connectors, duress, SOPS, the WebMCP tools, the support registries and the screens' view-models (`*-model.ts`) — everything in the client that is not UI, laid out as `apps/pages/src` was. A shell plugs in through one host (`configureHost`, `src/host.ts`) whose ports (`src/ports.ts`: storage, page, authenticator, environment, locks, broadcast, worker, OPFS, IndexedDB) are read at call time, never at import (`src/no-host-import.test.ts`). Hosts: `src/browser/host.ts` (Pages installs it first thing in `main.tsx` via `apps/pages/src/host/boot.ts`), `src/node/host.ts` (the CLI; file storage, 0600) and `src/sandbox/host.ts` plus `sandbox/runtime-contract.ts` (a bare V8 isolate such as Android's JavaScriptSandbox; proven by `sandbox/bare-isolate.test.ts`). Gated by `pnpm quality:app-core` |
| `packages/vault-core` | The vault format kernel (ADR 0133): header, KDF and seals, unlock records, the item model and paths, TOTP, the offline-backup envelope, the vault-file reader (`openVaultFile`), the secret-drop format and the golden vectors (`src/fixtures/vault-vectors.json`). Depends on `os-domain` and `vault-item-types` only — no host, no storage, no platform; strict compiler base. Import from the root: `import { openVaultFile } from "@opensesame/vault-core"` |
| `packages/vault-item-types` | Vault item type definitions (`definitions/*.json`), the closed field-type catalogue, the parser, and the runtime registry — one corpus for both planes (ADR 0087) |
| `packages/os-domain` | Domain models — must not import Better Auth/oidc-provider/Hono/Drizzle/React |
| `packages/database` | Drizzle schema + migrations |
| `packages/api-client` | Host API TS client |
| `packages/cli` | Client CLI, binary `opensesame-id` — includes `vault verify <file>` / `vault ls <file>` over an export or offline backup (master password from the terminal only; names and paths, never values) |
| `packages/auth-upstream` / `oauth-provider` / `claims` / `device-auth` | Identity-plane building blocks |
| `packages/policy` / `audit` / `contracts` | Authorization policy, audit trail, shared contracts |
| `packages/ceremony-kit` | UI-independent ceremony logic — canonical interaction URLs, the interaction client, display-safe summaries (ADR 0086) |
| `packages/wallet` | Vendor-neutral `WalletPassProvider` + Google Wallet Generic Pass adapter; optional, never on the approval path (ADR 0086) |
| `packages/openid4vp` | OpenID4VP **verifier** — request construction and presentation verification, digest-bound (ADR 0086) |
| `packages/openid4vci` | OpenID4VCI **issuer** for the minimal OpenSesame credential (ADR 0086) |
| `packages/sdk-browser` / `sdk-server` / `sdk-cli` | Client SDKs |
| `packages/agent-protocols` | Agent-facing protocol adapters |
| `packages/testing` | Shared test utilities (incl. `test:security`) |
| `packages/identity-atproto` / `identity-nostr` | Alternate-identity linking |
| `packages/observability` | Structured logging + deep redaction |
| `packages/notification-adapters` | Channel adapters (Slack, Teams, Telegram, WeChat, SMS bridge, Web Push, generic webhook) — provenance verification, rendering, delivery; no provider logic anywhere else (ADR 0084) |
| `packages/capability-registry` | Agent-surface parity source of truth — every capability maps or ADR-excludes each of cli/pwa/mcp/webmcp (ADR 0065); parity tests in each surface package sweep it |
| `packages/webmcp` | WebMCP (`document.modelContext`, with legacy `navigator.modelContext` fallback) browser library — feature detection, fenced registrar for `apps/pages`/`apps/pwa` tools |
| `packages/guide-lang` | GuideLang — the versioned tutorial language an in-product support model may write; parser, canonical serializer and validators. Deliberately cannot express a click, a selector or a URL (ADR 0088) |
| `packages/guide-runtime` | Deterministic GuideLang execution over ports only — no DOM, no renderer, no real timers; re-enforces every budget rather than trusting the parser |
| `packages/support-agent` | Provider-neutral support port, semantic page context, system-instruction builder and the egress boundary — no React, no vendor model SDK |
| `packages/config` | Shared tsconfig |
| `packages/env-spec-bridge` | env-spec ↔ runtime config bridge |
| `skills/` | Agent skills — see §7 |
| `wit/` | Polyglot core contracts (client, connector, core, host, mediation, proof, task) |
| `docs/` | Architecture, ADRs, security, operators, validation, implementation docs; competitor references under `docs/competitors/`; ecosystem research under `docs/research/` |

## 5. Design rules that gate merges

- **A user-visible change ships with before/after evidence on the pull
  request.** A reviewer must never have to clone the branch, install, build and
  walk the app to find out whether a change helped, and "I ran it and it looks
  good" is a claim about a screen nobody else saw. Any diff a person could
  notice — CSS, a component, a screen, layout, chrome, on-screen copy, an icon,
  an empty or error state, a focus ring — carries images captured from **two
  real builds**: the base branch's and this one's, walked the same way, at
  phone and desktop width. Every pair carries a measurement taken from the
  browser (`statusline 99px, wrapped → 49px, one row`), never an impression.
  The sheets are committed under `docs/evidence/<yyyy-mm-dd>-<topic>/` beside
  a `README.md` that lays them out, and the PR body links that gallery under
  `## Visual evidence` by commit SHA so it survives the branch. The body cannot
  carry the images itself — the GitHub tooling here strips image embeds — so
  read the PR back and check the markup survived whatever you posted. Never stage a screenshot, never crop away the thing you
  changed, and where a visible change genuinely cannot be captured, say so in
  the PR and name what you verified instead — silence reads as "nothing to
  see". Procedure and tooling: `skills/visual-evidence/SKILL.md`,
  `apps/pages/scripts/capture-evidence.mjs`.
- **Local app runs are attached HMR debug sessions.** "Run it locally",
  "start the app", or "let me test" means: keep the Vite (or other) dev
  server as a long-lived attached process, open that origin in a
  browser/debug session, and watch console errors, page errors, and failed
  requests with full stacks. Fix against the hot-reloaded session; do not
  kill it to run a production `dist/` or a headless `verify:*` harness
  unless that gate was the request. Pages UI without a backend is
  `pnpm --filter @opensesame/pages dev:web` on `:5180`. Procedure:
  `skills/local-debug-session/SKILL.md`.
- **Keyboard access is a core product contract, not optional polish.** Every
  arrival (cold load, reload, guest/unlock, deep link, route change and modal
  close) must leave visible, useful focus. Never steal focus from an active
  user. Native links/buttons retain Enter/Space behavior; form controls,
  tabs and menus retain their own keys. Global shortcuts must not swallow
  native activation. Tab/Shift-Tab must reach and leave both trees and every
  visible enabled control; only an active modal may contain focus. F6 is the
  listing-switch shortcut, never a replacement for native Tab navigation.
  Escape leaves a text field for its parent pane before closing a closable
  pane. Preserve vim/tree arrows, counts, section chords and guest access.
  Changes to boot, routing, shell, controls or focus require
  `pnpm --filter @opensesame/pages verify:keyboard` against a fresh Pages
  build, at desktop and mobile widths. This keyboard-only browser journey
  must start at page load without clicks, injected focus, synthetic keydown
  events or mocked keymap registrations. Handler spies and snapshots alone
  are not regression proof. Include saved-vault reload/unlock and immediate
  movement from empty and populated vaults; guest entry alone is insufficient.
  Keep this gate in the required Bundle budgets
  job; demonstrate failure before fixing a regression and success afterward.
- **A phone is not a narrow desktop, and the touch rules are gated on width as
  well as pointer.** The 44px floor, the 16px field floor that keeps iOS from
  zooming a focused field and never zooming back, the single-row statusline,
  the safe-area insets and the landscape arrangement are all measured by
  `pnpm --filter @opensesame/pages verify:mobile` against a fresh Pages build,
  at 320, 390, 430 and landscape. Changes to the shell, the chrome, any shared
  control, or any block under `(pointer: coarse)` require it. A screenshot is
  not evidence: the gate measures computed geometry in a real touch context
  and fails closed if that context is lost. Keep it in the required Bundle
  budgets job. Never satisfy it by clipping a control, hiding a road, or
  lowering a floor — DESIGN.md § Touch is the contract it enforces.
- **Browser-local IAM must prove an actual application sign-in.** Changes to
  local identity sessions, application grants, popup transport or consent
  require `pnpm --filter @opensesame/pages verify:local-iam` against a fresh
  Pages build, alongside the focused IAM tests. This required Bundle budgets
  check uses separate browser origins, real encrypted storage and virtual
  WebAuthn, with keyboard-only explicit consent, session check, revocation
  and denial at desktop/mobile widths. A registration form or mocked success
  is not authentication evidence. Keep exact-origin/source binding, PKCE,
  human-only consent and scoped opener headers; never widen model authority
  to make the flow pass. Browser-local identity is not a hosted OIDC service.
- `@opensesame/os-domain` **must not** import Better Auth, oidc-provider,
  Hono, Drizzle, or React (see CONTRIBUTING.md).
- Prefer mature libraries over NIH protocol code —
  [ADR 0008](docs/adr/0008-better-auth-oidc-provider.md).
- Do not add Clerk/Marketplace auth as core —
  [ADR 0004](docs/adr/0004-no-vercel-marketplace-for-core.md) (Vercel
  Marketplace *hosting* for previews is fine; auth is not).
- Identity API and Host API stay separate — no BFF merge —
  [ADR 0017](docs/adr/0017-host-client-product-topology.md).
- Record consequential decisions as ADRs under `docs/adr/` (currently
  0001–0133).
- **The static front end is complete without a backend**
  ([ADR 0090](docs/adr/0090-static-frontend-complete-without-backend.md)).
  `apps/pages` is a broker: an empty device opens on the sign-in screen with
  the compiled-in Google-via-Shoo road and the guest road, and nothing — no
  operator ceremony, no Identity API, no Host, no daemon, no localhost — may
  be placed in front of them. On a device with no vault and no setup record
  that screen is the **front door** (`screens/FrontDoor.tsx`,
  [ADR 0115](docs/adr/0115-front-door-and-connector-directory.md)): the
  wordmark at hero scale, the `Set up your own` road made large, and the
  whole sign-in panel beneath it on the same card — offers beside sign-in,
  never a gate before it. Join is invite-link only (an invite opens join
  by itself); once the ceremony is answered or skipped, setup lives behind
  unlock (Settings), not as quiet foot links. `setupRequired` does not
  exist and must not come back. No
  default may point at a local host: `packages/app-core/src/lib/settings.ts` defaults are empty on
  every origin, and `127.0.0.1` addresses are suggestions a loopback tab may
  offer, never something the app assumes. With no Identity API configured a
  guest or federated sign-in is complete, not pending — no notice may name a
  service that is not there. A screen is gated on what it actually needs, one
  panel at a time (`useHostConfigured`, `NoHostNote`), never on "a backend":
  Access › Resources is Identity-plane and local-only, Sessions' receipts are
  Identity-plane, and gating those on a Host hid features that need none. A
  deployment that asks nothing may never report that something failed.
- Never expose raw secrets, private proof keys, or a public `getSecret()`
  affordance. Agent-facing APIs use ConnectionRef + Intent
  ([ADR 0005](docs/adr/0005-authority-handle-connectionref.md)).
- **Never remove or hide the guest/anonymous access flow** from the Pages
  sign-in and unlock screens. It lives in three places and all three are
  required: the "Continue as guest" button in
  `apps/pages/src/screens/unlock/SignInPanel.tsx` on **both** placements
  (first run *and* the sign-in panel opened from the user menu beside an
  existing vault), the "Skip" corner link on first run, and the "Continue as
  guest" link in the unlock form's footer in
  `apps/pages/src/screens/UnlockScreen.tsx`. This flow has
  been removed by accident repeatedly — by gating it on Identity API
  availability, and by withholding it beside an existing vault. Neither is
  legitimate. `continueAsGuest` (`packages/app-core/src/lib/guest-auth.ts`) seals a
  local vault and works with no Identity service at all; the registered-auth
  claim degrades to a bell notice (ADR 0033). Beside a sealed vault the store
  runs the guest in the isolated `GUEST_TOMB` (`packages/app-core/src/lib/vault/store.ts`
  `createGuest`), so the existing vault is never read, written, or deleted,
  and `lock()` keeps the unlock screen on guest when that was the last
  authorized account — isolation is the answer to "a guest would
  clobber the vault", suppression is not. Do not gate guest on
  `hasIdentityService`, `noWayIn`, the provider catalog, first-run setup
  allowlists, or vault status. The only road that is legitimately withheld
  beside an existing vault is "Use without an account" (a local-only seal in
  place). Any change that drops a guest entry is a regression, not a cleanup —
  the tests in `SignInPanel.test.tsx`, `UnlockScreen.test.tsx`, and
  `store.test.ts` asserting guest exists and stays isolated are load-bearing
  and must not be deleted or inverted.
- A device knows two things and the unlock screen states both: **who** is
  signed in (the Identity session plus the upstream assertion federation saved)
  and **which key** opens the vault (the passkey/PIN/password wraps in the
  plaintext header, then the authenticator gate if enrolled). The unlock tabs
  are exactly the enrolled methods, never a uniform three; an enrolled
  authenticator code is announced as step 2 before step 1 is taken. Sign out
  is one operation in `packages/app-core/src/lib/session-exit.ts` (forget the
  assertion, revoke Identity, lock, note it for the sign-in panel); "switch
  account" is that plus `prompt=login` on the next OIDC leg, and never on
  Shoo's dialect, which ignores it. A second step (authenticator, email or
  text code) may be enrolled only once a primary method exists and only after
  a code from it matches — a guest can never write a gate with no key behind
  it, and a guest who asks for one is walked through the key first, in the
  same sheet. Settings › Security is a read-only list — one row per method,
  one action, never an input — and one sheet
  (`apps/pages/src/sections/settings/security/`) built from `CeremonyShell`
  and `FieldShell`; do not draw a form under a row, and do not draw a second
  PIN or password form anywhere. Email and text codes are fallbacks the
  Identity API sends (`/v1/mfa/code/send|verify`), offered only where one is
  configured, with NIST 800-63B's notice before the address is asked for;
  recovery codes are the vault's, sealed whole under its key, and stand in
  for any second step once each
  ([ADR 0091](docs/adr/0091-account-exits-and-unlock-ceremony.md)).
- A device holds several vaults (the personal tomb, one per project, the
  guest tomb), and there is exactly one list of them: `listDeviceVaults()` in
  `packages/app-core/src/lib/vaults.ts`, rendered by `components/VaultList.tsx` on the
  front door (`screens/VaultsScreen.tsx`), the `@tomb` prompt, and Settings →
  Vaults. Do not add a second switcher. A project's name is sealed inside its
  tomb, so nothing may show it before unlock (`vaultLabel` says
  `project · 4f2a`); a vault opens without a prompt only when
  `VaultStore.sharesKeyWith` proves it shares the session's wrap material
  ([ADR 0089](docs/adr/0089-device-vault-switching.md)).
- Anything with a deadline (certificate, CA, signer, brokered credential,
  rotation policy) is detected by the lifecycle scanner and published on the
  `lifecycle.*` hook feed — never by a subsystem's own private due-check.
  `OpenSesame`'s own rotation subscribes to that feed, so a break in it breaks
  our rotations too ([ADR 0074](docs/adr/0074-expiry-lifecycle-hooks.md)).
- Every security fact — an expiry, a breached password, a provider disclosure —
  becomes a `SecurityNotice` and publishes through `security::dispatch`. A
  detector never gets its own notification path: it converts into the shared
  envelope and inherits the subscriptions, the delivery ledger, the built-in
  notifier and alerter, and every industry-standard sink
  ([ADR 0080](docs/adr/0080-security-event-hooks.md)).
- Breach checks disclose nothing about a tenant: passwords go through the Pwned
  Passwords range API's k-anonymity (five hex characters of a SHA-1 leave the
  host), and provider checks fetch the public catalogue whole and match
  locally. The breached-account API is deliberately unused — it would mean
  disclosing addresses held on somebody else's behalf (ADR 0080 §5).
- A certificate is renewed unattended only when the host holds its key
  (`managed_certificate_keys`); one whose key went to its requester reports
  `not_in_custody` rather than minting a key with no recipient. Custody is opt-in
  (`managed: true`), never agent-reachable, and its renewal lead is clamped to
  half the lifetime so renewal terminates
  ([ADR 0075](docs/adr/0075-host-certificate-key-custody.md)).
- **mTLS is optional, per hop, and never a fallback**
  ([ADR 0132](docs/adr/0132-optional-mtls-and-workload-identity.md)). The
  static core is untouched: `apps/pages` needs no certificate, no environment
  and no backend, and a browser cannot attach a vault key to `fetch`'s TLS —
  `browser_vault_key_injection` is always `unsupported`. Authentication is not
  authorization: a verified peer (`VerifiedPeer`, never deserialized from a
  header or body) must resolve to exactly one operator-written service
  binding — exact `spiffe_id` / `dns_name` / `uri_san` / thumbprint, no CN,
  email, IP or wildcard, no fleet role — and then pass the ordinary PEP,
  grant and ConnectionRef checks. Custody is stated truthfully: PEM files are
  file-readable, a managed certificate is Host-sealed and exportable to the
  Host, a Workload API SVID is delivered to the process; nothing is called
  hardware-bound. A configured `mtls_required` hop with missing or invalid
  material refuses to start; it does not downgrade to bearer, plaintext, the
  memory bus or a shared certificate. Revocation is bounded per layer (next
  handshake, next protected request, NATS server-side expiry, the token's own
  TTL) and erases nothing from a browser. The daemon keeps its serde + std
  budget; browser packages get no `node:tls`. Operator reference:
  `docs/operators/mtls.md`.
- Where a person is notified and what it takes for them to approve are separate
  mechanisms. A preference may reorder and narrow the destinations policy
  allows; it can never admit a channel policy refused, and never lowers an
  assurance requirement. Channel capability is a closed record in
  `packages/os-domain/src/notifications.ts` — no adapter declares its own, and
  no channel but the in-app ceremony may claim phishing resistance. Direct
  external settlement is default-deny and needs an explicit per-channel policy
  opt-in *and* the assurance gate; a provider-signed callback proves provenance,
  never authorization ([ADR 0084](docs/adr/0084-external-authorization-notifications.md)).
- A sensitive approval is bound to its transaction: the WebAuthn activation
  commits to the request digest, the decision verb, and the effective policy
  digest, and is spent by a durable compare-and-set. An activation minted for
  one request, one verb, or one policy can never settle another (ADR 0084).
- A vault item type is a manifest, never a code path. Adding one is a JSON
  file in `packages/vault-item-types/definitions/` (embedded by both planes),
  and a user can install one at runtime with no build. Fields name types from
  the closed catalogue; a concealed field may never reach `subtitle`, `search`,
  or a VFS filename; only a platform-published definition may name a ceremony
  handler ([ADR 0087](docs/adr/0087-vault-item-type-plugins.md)).
- A connector arrives by reference, never by credential. The connectors tab
  of setup and Access › Connectors read a Nango-compatible directory's two
  listing routes and nothing else; `GET /connection/{id}` — the route that
  returns tokens — is never called, no Nango package is depended on, and the
  directory's key is sealed in the tomb or held in memory, never written in
  the clear. Binding a connector to a person or agent is a local share grant
  of kind `connection` — the one ledger Identity shares use — not a second
  authority model ([ADR 0115](docs/adr/0115-front-door-and-connector-directory.md)).
- Every new user-facing capability (gateway route, CLI verb, PWA action) must
  get a `packages/capability-registry` entry that maps it onto the MCP/WebMCP
  surfaces or excludes it with an ADR citation — parity tests in mcp-host,
  mcp-client, pages, and both CLIs enforce this
  ([ADR 0065](docs/adr/0065-agent-surface-parity.md)).
- A cross-device handoff is an `Interaction` and nothing else. Every surface —
  QR, Google Wallet, the PWA, a CLI link, a future wallet provider — is a
  presentation adapter over the one envelope, and every proof mechanism is an
  adapter over `ApprovalProof`. Do not add a second authority model beside it:
  a reference authorizes nothing, and an approval counts only when
  `proof.boundDigest` equals the interaction's `requestDigest`
  ([ADR 0086](docs/adr/0086-wallet-native-interaction-layer.md)).
- Payment *authorization* is in scope; payment *credentials* never are.
  `assertNoPaymentCredentials` refuses card data by field name and by
  Luhn-checking values, and OpenSesame issues no cards, provisions no DPANs and
  stores no PAN/CVV (ADR 0086 §6).
- In-product support guides by *pointing*, never by acting. A model may emit
  GuideLang and nothing else, and GuideLang has no directive for a click, a
  keystroke, a submit, a fetch, a tool call, a selector or a URL — an id it
  names is resolved through the target registry in
  `packages/app-core/src/tutorial/registry`, or the program is discarded whole. Model
  text reaches the document as text; the renderer hands Driver.js a placeholder
  and writes prose with `textContent`. Page context is assembled from authored
  registries only, never from the DOM, so no secret, item name or folder name
  has a path into a prompt. A new control worth asking about gets a catalog
  entry with checked-in prose; a new authored guide is compiled by the same
  parser and validator model output goes through
  ([ADR 0088](docs/adr/0088-ai-native-contextual-support.md)).
- **Every new user-facing feature is a capability, and an optional one never
  loads before consent**
  ([ADR 0130](docs/adr/0130-operator-controlled-capability-composition.md)).
  Adding a feature is five things beside ADR 0065's registry entry: a
  descriptor in `packages/app-core/src/lib/capabilities/catalog-*.ts`, a module entry
  `apps/pages/src/modules/<capability-id>/runtime.ts` exporting
  `capabilityRuntime`, an ownership rule in `apps/pages/src/lib/capabilities/ownership.ts`
  plus a source-classification rule, an operation mapping in
  `packages/capability-registry/src/capability-map.ts`, and a profile fixture
  that proves its **absence** (`minimal-local` resolves to zero optional
  capabilities). A capability owns operations; it is not one, and nothing in
  the registry is renamed to make it fit. Optional code reaches the page only
  through `loadApprovedModule` under a current lease, after the plan approved
  it and a `ConsentReceipt` covered its exposure digest — a configured
  endpoint, a skipped setup tab, a remembered provider or a cached chunk is
  none of them consent. **The bootstrap may not statically import an optional
  module**: `main.tsx` resolves the plan and then `import()`s `app-root.js`,
  modules have no top-level side effects, and the build fails on reachability
  of an excluded module from any entry. Scopes only narrow — distribution,
  instance, workspace, installation, vault session — so a smaller permitted
  set can never enlarge the approved one. Changes to the bootstrap, a module,
  a worker or the build run `pnpm --filter @opensesame/pages build:profile`
  and `verify:capability-graph`; a contract with no landed test is recorded
  `pending` in `docs/evidence/capability-composition/contract-test-matrix.json`
  rather than left to read as covered. Operator guide:
  `docs/operators/capability-composition.md`; verification method:
  `docs/validation/capability-composition.md`.
- **A source file stays under 400 lines and the debt ledger only falls**
  ([ADR 0093](docs/adr/0093-structural-quality-gates.md)). `pnpm quality`
  measures module size and TypeScript complexity against thresholds that mirror
  `clippy.toml`, and scores every pnpm package and Cargo crate against Robert
  C. Martin's component principles. A dependency cycle (ADP) and an import of
  an undeclared workspace package are hard failures. Everything else ratchets
  against `quality-baseline.json` and `package-metrics-baseline.json`: a file
  may not exceed its recorded number, **and a file that improves must have its
  baseline tightened in the same commit** (`pnpm quality:gate --update`). Never
  raise a recorded number to make the gate pass — split the file. New files get
  a recorded number of zero, so new code meets the budget outright.
  `docs/validation/code-quality-gates.md` is the working guide.
- Pages, PWA, and ceremony UI follow [`DESIGN.md`](DESIGN.md) and
  [`docs/design/controls.md`](docs/design/controls.md). An action that
  executes is an icon key (`icon-btn`, or `.go` for the action that ends the
  screen) with `aria-label` and `title`. Do not paint a verb on a button.
  Text on a control is only a choice object (a provider, a mode, a navigation
  target, the guest road). A status is a `StatusMark` glyph, never a text
  pill. Do not render an in-page error box (`note`, `conn-flash`, or a
  paragraph banner). Do not add explainer or caption prose. Pages copy never
  names a Host, and a browser-local connector action never asks the person to
  pair one. `pnpm lint:design` (`scripts/design-lint.mjs`) rejects word-verb
  buttons, status pills, and explainer captions; `impeccable detect`
  enforces the same design file. Both run in `.githooks/pre-commit`. The
  word-verb ledger is `scripts/design-button-baseline.json` and only falls.
- No `sudo` (`.cursor/rules/no-sudo.mdc`).
- Configuration follows the `.env.schema` env-spec pattern (`@type`,
  `@required`, `@sensitive`, `@public` annotations). Never commit live
  secrets; dev signing keys and claim peppers are generated outside git.

## 6. Security posture

- `docs/security/notification-approval-threat-model.md` — trust boundaries and
  residual risks for external notification and approval (ADR 0086);
  `docs/operators/notification-channels.md` — the channel capability matrix and
  per-provider setup.
- `docs/security/security-boundaries.md`, `docs/security/threat-model.md`,
  `docs/security/identity-threat-model.md`,
  `docs/security/key-hierarchy.md` — architecture-level security docs.
- `docs/security/audit-YYYY-MM-DD-<topic>.md` — a running series of
  point-in-time audit docs, each documenting a specific vulnerability that
  was found and fixed. Add a new dated file rather than editing history.
- `docs/security/tooling-evaluation.md` — evaluation of the audit gate
  tooling.
- Gate scripts (invoked via the `pnpm audit:*` scripts in §3):
  `scripts/cve-lite-gate.sh`, `scripts/ast-grep-security-gate.sh`,
  `scripts/clippy-gate.sh`, `scripts/osv-scanner-gate.sh`,
  `scripts/cargo-audit-gate.sh`, `scripts/gitleaks-gate.sh`,
  `scripts/semgrep-gate.sh`, `scripts/daemon-deps-gate.sh`.

### Codex Security checker

`codex-security` is an external, model-backed review tool. It supplements the
deterministic `pnpm audit:*` gates; it does not replace them. CLI `0.1.20` with
bundled plugin `0.1.37` was the latest release validated in this repository on
2026-08-25.

Before a scan, check the installed and published versions. Upgrade only when
the task authorizes changing user-level tooling, and install an exact version:

```bash
codex-security --version
npm view @openai/codex-security version dist-tags --json
npm install -g @openai/codex-security@<exact-version>
codex-security --version
```

Routine reviews must target explicit security-boundary paths or a committed
diff. Never start a bare, uncapped repository-wide scan. Use the stored ChatGPT
sign-in, GPT-5.6 Luna, and low reasoning by default so reviews consume the
user's Codex subscription allowance and preserve it for coverage. Do not use
`--auth auto`: unattended scans give API keys precedence. Use `--auth api-key`
only when the human explicitly requests API billing. Set one shared budget
before permitting network access, run preflight first, and retain artifacts
outside the checkout:

```bash
codex-security scan <clean-checkout> \
  --path <security-boundary> \
  --path <another-security-boundary> \
  --auth chatgpt \
  --model gpt-5.6-luna --effort low \
  --mode standard \
  --max-cost 15 \
  --fail-on-severity high \
  --headless --verbose \
  --output-dir <trusted-state-dir> --archive-existing \
  --dry-run

# Remove --dry-run only after checking paths, model, effort,
# authentication method, output directory, and maxCostUsd in preflight output.
```

The `$15` cap is shared by every repeated `--path` in that invocation; it is
not a separate allowance per path. The cap is a ceiling, not a promise that
the scan will finish.
Raising it or running a whole-repository scan requires explicit human approval.
With CLI `0.1.16` at `xhigh`, prior runs demonstrated why: a full scan consumed
`$56.73` after only `64/2,313` files, and a 70-file diff hit `$15.05` after
`10/70` files. Use `--path` to split intentionally selected security boundaries
when a complete diff cannot fit the approved budget. Record any lower reasoning
effort as a coverage limitation.

Committed-diff scans require a completely clean checkout, including no
untracked files. Never stash, remove, or overwrite user work to satisfy this
check. Scan a disposable local clone at the same HEAD instead:

```bash
repo_root="$(git rev-parse --show-toplevel)"
scan_root="$(mktemp -d -p /tmp opensesame-codex-security.XXXXXX)"
git clone --no-local "$repo_root" "$scan_root/repo"
base_sha="$(git -C "$repo_root" rev-parse <base-sha-or-ref>)"
# Use "$scan_root/repo" as <clean-checkout> and "$base_sha" as the diff base.
```

Do not run that setup with `sudo`, and do not change repository or ancestor
ownership. Codex Security rejects an output directory when any ancestor is
owned by neither root nor its effective UID. Managed sandboxes may map `/`,
`/home`, and `/tmp` to UID `65534`, so changing the leaf directory cannot fix
`Scan output parent must have a trusted owner`.

When that ownership error occurs, the harness must run the checker in an
isolated user namespace/container with this mount contract:

- a synthetic root owned by the namespace's effective UID;
- the clean checkout mounted read-only at `/workspace`;
- a dedicated host artifact directory mounted read-write at `/state`;
- an ephemeral `CODEX_HOME`, with only required auth/config inputs mounted
  read-only;
- runtime libraries, certificates, and the resolver target mounted read-only;
- the scan launched from `/workspace` with `--output-dir /state`.

This Bubblewrap invocation is the known-good Linux implementation. Replace the
three host paths and scan arguments; if `/etc/resolv.conf` targets a different
absolute path, mount that target read-only instead of `/mnt/wsl`:

```bash
bwrap --unshare-user --uid 0 --gid 0 --tmpfs / --dev /dev --proc /proc \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /etc /etc --dir /mnt --ro-bind /mnt/wsl /mnt/wsl \
  --dir /home --dir /home/codex \
  --ro-bind /home/codex/.local /home/codex/.local \
  --dir /home/codex/.codex \
  --ro-bind /home/codex/.codex/auth.json /home/codex/.codex/auth.json \
  --ro-bind /home/codex/.codex/config.toml /home/codex/.codex/config.toml \
  --dir /workspace --ro-bind <clean-checkout> /workspace \
  --bind <trusted-host-state-dir> /state --tmpfs /tmp \
  --setenv HOME /home/codex \
  --setenv PATH /home/codex/.local/bin:/usr/bin:/bin \
  --chdir /workspace /home/codex/.local/bin/codex-security scan /workspace \
  --path <security-boundary> --path <another-security-boundary> \
  --auth chatgpt \
  --model gpt-5.6-luna --effort low --mode standard \
  --max-cost 15 --fail-on-severity high \
  --headless --verbose --output-dir /state --archive-existing --dry-run
```

Keep `--dry-run` for the first invocation. Remove it only after the printed
preflight is correct and model/repository egress has been approved.

Do not weaken the ownership check, use world-writable auth/config files, expose
the host home, or make the repository writable to the scanner. Obtain explicit
approval for the model's network/repository-content egress.

Interpret results narrowly:

- `cost_limit_exceeded`, interruption, or `partial_output=true` is incomplete;
- only entries marked `completed` in
  `artifacts/02_discovery/work_ledger.jsonl` were actually reviewed;
- `no_candidate` means no candidate in that completed file, not that the diff
  or repository is secure;
- `--fail-on-severity` is a release gate only after a complete scan;
- validate every candidate against the source-to-sink path before changing
  code, then add a regression test at the enforcement boundary;
- report CLI/plugin versions, base/head SHAs, scope, effort, cap and actual
  cost, completed/total files, findings, and residual unreviewed scope.

Keep scanner artifacts private. They may contain sensitive paths or threat
models. Never publish exploit details, tokens, credentials, claim values, or
other secret material in issues, logs, or scan reports.

## 7. Skills

Agent skills live under `skills/*/SKILL.md` (canonical). `.agents/skills/`
holds symlinks to the same directories for tools that look there instead —
except third-party installs (currently `impeccable`), which live there
directly so their own updater can refresh them.

| Skill | Path | Purpose |
|-------|------|---------|
| `opensesame-apis` | `skills/opensesame-apis/SKILL.md` | Install, configure, initialize, and use OpenSesame Host and Identity APIs |
| `opensesame-chrome-extension` | `skills/opensesame-chrome-extension/SKILL.md` | Install, configure, initialize, and use the OpenSesame browser extension |
| `opensesame-clis` | `skills/opensesame-clis/SKILL.md` | Install, configure, initialize, and use OpenSesame host and client CLIs |
| `opensesame-mcps` | `skills/opensesame-mcps/SKILL.md` | Install, configure, initialize, and use OpenSesame MCP servers |
| `install-anti-slop` | `skills/install-anti-slop/SKILL.md` | Install and configure the vendored Oxlint anti-slop plugin |
| `security-review` | `skills/security-review/SKILL.md` | Run repository security gates and targeted Codex Security reviews |
| `visual-evidence` | `skills/visual-evidence/SKILL.md` | Capture before/after screenshots from two real builds for any user-visible change and post them on the PR |
| `local-debug-session` | `skills/local-debug-session/SKILL.md` | Attach a live HMR debug session when asked to run the app locally; watch real console/page/network errors and patch the hot-reloaded process |
| `impeccable` | `.agents/skills/impeccable/SKILL.md` | Third-party frontend design skill ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), Apache 2.0), installed via `npx impeccable install` — lives in `.agents/skills/` (not `skills/`) so `npx impeccable update` can refresh it; design detector hook in `.codex/hooks.json` + `.claude/settings.local.json` |
| `scandinavian-design` | `.claude/skills/scandinavian-design/SKILL.md` | Third-party ([ericzakariasson/scandinavian-design](https://github.com/ericzakariasson/scandinavian-design)), installed via `npx skills add ericzakariasson/scandinavian-design` — the visual-restraint contract behind the Scandinavian retoken; its `scripts/*.js` verifiers are patched to launch the container's pinned Chromium (`/opt/pw-browsers/chromium`) instead of a system Chrome |
| `minimalist-ui` | `.claude/skills/minimalist-ui/SKILL.md` | Third-party ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT), installed via `npx skills add Leonxlnx/taste-skill -s minimalist-ui` |
| `design-taste-frontend` | `.claude/skills/design-taste-frontend/SKILL.md` | Third-party anti-slop frontend skill ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT; docs at [tasteskill.dev](https://www.tasteskill.dev/changelog)) |
| `redesign-existing-projects` | `.claude/skills/redesign-existing-projects/SKILL.md` | Third-party audit-first redesign skill ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT) |
| `design-system` | `.claude/skills/design-system/SKILL.md` | TypeUI `minimal` registry spec ([typeui.sh](https://www.typeui.sh/design-skills)), pulled via `npx typeui.sh pull minimal -f skill -p claude-code`; also mirrored at `.agents/skills/design-system/` |

## 8. Verification expectations

A local debug session (`dev:web` / attached browser) is how the human
watches the app. It does not replace the merge gates below.

Before pushing:

```bash
pnpm lint && pnpm quality && pnpm typecheck && pnpm test
```

If the change is user-visible, also capture its evidence and put it in the PR
body — see `skills/visual-evidence/SKILL.md`. The gates prove the contract
holds; the images are the only thing that shows a reviewer what the change
actually did:

```bash
J=docs/evidence/<yyyy-mm-dd>-<topic>/journey.json
git checkout "$(git merge-base HEAD origin/main)" -- apps/pages/src   # the base
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture before "$J"
git checkout HEAD -- apps/pages/src                                    # the branch
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture after "$J"
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs compose "$J"
```

For the full local gate suite (what `pnpm verify` runs — required before
anything security-sensitive lands):

```bash
pnpm verify   # lint + quality gates + rustfmt/full-feature Clippy + test:all
              #   + cargo +1.88.0 test --workspace --all-targets
              #   + ./scripts/battle-test.sh
```

CI lives in `.github/workflows/`:

- `ci.yml` — runs on `pull_request`: TypeScript job
  (verified-commit signature preflight + frozen install + `pnpm lint` + `pnpm quality` + `pnpm typecheck` +
  `pnpm test`) and
  Rust job (`cargo test --workspace --all-targets`, Rust 1.88.0), plus a
  Bundle budgets job that builds `apps/pages`/`pwa`/`console` and checks
  `bundle-budgets.json`. The default-branch ruleset requires all three checks
  and an up-to-date PR, with squash auto-merge; this personal-account repository
  does not support merge queues. Verify actual settings with
  `node ops/github/governance.mjs --verify`.
- `deploy-pages.yml` — on every push to `main`, builds `apps/pages` and
  publishes it to GitHub Pages via `actions/deploy-pages` (Pages source
  must be "GitHub Actions"). A release marker and post-deploy HTTPS digest check
  prove the live HTML/runtime configuration matches the exact source SHA.
  `scripts/deploy-pages.sh` remains as the
  manual/local fallback publisher.

CI is the merge gate, not the whole story: the heavier suites
(`pnpm verify`, integration/e2e, `pnpm audit:*`) stay local — git hooks
plus the commands above, supplemented by scheduled Claude Code sessions
documented in `docs/operations/agent-routines.md`. Run the relevant
`pnpm audit:*` gates (§3/§6) for changes touching auth, crypto, or
dependency surfaces.
