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
- Vitest `4.1.10` (TS unit/integration tests), Playwright `1.55.1` (e2e)

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

**Pages (offline PWA) dev server:**
```bash
pnpm --filter @opensesame/pages dev   # vite --port 5180 --strictPort
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
| `apps/pages` | Installable GitHub Pages offline PWA — authority vault |
| `apps/pages/src/tutorial` | In-product contextual support: the semantic target/route/predicate registries, the Driver.js renderer, the on-device and AG-UI transports, and the support panel (ADR 0088) |
| `apps/mcp-client` / `apps/mcp-host` | MCP servers (client- and host-facing) |
| `apps/console` | Vite Identity console (web UI) |
| `apps/worker` | Background worker |
| `apps/browser-extension` | WXT browser extension |
| `apps/example-rp-alpha` / `apps/example-rp-beta` | Example relying-party apps |
| `apps/example-agent` / `apps/example-headless` | Example agent / headless client |
| `packages/vault-item-types` | Vault item type definitions (`definitions/*.json`), the closed field-type catalogue, the parser, and the runtime registry — one corpus for both planes (ADR 0087) |
| `packages/os-domain` | Domain models — must not import Better Auth/oidc-provider/Hono/Drizzle/React |
| `packages/database` | Drizzle schema + migrations |
| `packages/api-client` | Host API TS client |
| `packages/cli` | Client CLI, binary `opensesame-id` |
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
  0001–0091).
- **The static front end is complete without a backend**
  ([ADR 0090](docs/adr/0090-static-frontend-complete-without-backend.md)).
  `apps/pages` is a broker: an empty device opens on the sign-in screen with
  the compiled-in Google-via-Shoo road and the guest road, and nothing — no
  operator ceremony, no Identity API, no Host, no daemon, no localhost — may
  be placed in front of them. `Deployment setup` and `Join a session` are
  ceremonies a person opens from the sign-in foot (an invite link opens join
  by itself); `setupRequired` does not exist and must not come back. No
  default may point at a local host: `lib/settings.ts` defaults are empty on
  every origin, and `127.0.0.1` addresses are suggestions a loopback tab may
  offer, never something the app assumes. With no Identity API configured a
  guest or federated sign-in is complete, not pending — no notice may name a
  service that is not there.
- Never expose raw secrets, private proof keys, or a public `getSecret()`
  affordance. Agent-facing APIs use ConnectionRef + Intent
  ([ADR 0005](docs/adr/0005-authority-handle-connectionref.md)).
- **Never remove or hide the guest/anonymous access flow** from the Pages
  sign-in and unlock screens. It lives in three places and all three are
  required: the "Continue as guest" button in
  `apps/pages/src/screens/unlock/SignInPanel.tsx` on **both** placements
  (first run *and* the "Sign in" tab beside an existing vault), the "Skip"
  corner link on first run, and the "Continue as guest" link in the Unlock
  tab's footer in `apps/pages/src/screens/UnlockScreen.tsx`. This flow has
  been removed by accident repeatedly — by gating it on Identity API
  availability, and by withholding it beside an existing vault. Neither is
  legitimate. `continueAsGuest` (`apps/pages/src/lib/guest-auth.ts`) seals a
  local vault and works with no Identity service at all; the registered-auth
  claim degrades to a bell notice (ADR 0033). Beside a sealed vault the store
  runs the guest in the isolated `GUEST_TOMB` (`apps/pages/src/lib/vault/store.ts`
  `createGuest`), so the existing vault is never read, written, or deleted,
  and `lock()` hands it back — isolation is the answer to "a guest would
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
  is one operation in `apps/pages/src/lib/session-exit.ts` (forget the
  assertion, revoke Identity, lock, note it for the Sign in tab); "switch
  account" is that plus `prompt=login` on the next OIDC leg, and never on
  Shoo's dialect, which ignores it. An authenticator code may be enrolled only
  once a primary method exists and only after a code from the app matches — a
  guest can never write a gate with no key behind it
  ([ADR 0091](docs/adr/0091-account-exits-and-unlock-ceremony.md)).
- A device holds several vaults (the personal tomb, one per project, the
  guest tomb), and there is exactly one list of them: `listDeviceVaults()` in
  `apps/pages/src/lib/vaults.ts`, rendered by `components/VaultList.tsx` on the
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
  `apps/pages/src/tutorial/registry`, or the program is discarded whole. Model
  text reaches the document as text; the renderer hands Driver.js a placeholder
  and writes prose with `textContent`. Page context is assembled from authored
  registries only, never from the DOM, so no secret, item name or folder name
  has a path into a prompt. A new control worth asking about gets a catalog
  entry with checked-in prose; a new authored guide is compiled by the same
  parser and validator model output goes through
  ([ADR 0088](docs/adr/0088-ai-native-contextual-support.md)).
- A screen's terminal commit is the shared `.go` ink square with its verb
  beside it; `.btn--primary` with a text label is for actions *inside* a card.
  Both patterns are named in [`docs/design/controls.md`](docs/design/controls.md)
  and enforced by `pnpm lint:design` (`scripts/design-lint.mjs`), which runs in
  the `pre-commit` hook and a Claude Code `PostToolUse` hook.
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
| `impeccable` | `.agents/skills/impeccable/SKILL.md` | Third-party frontend design skill ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), Apache 2.0), installed via `npx impeccable install` — lives in `.agents/skills/` (not `skills/`) so `npx impeccable update` can refresh it; design detector hook in `.codex/hooks.json` + `.claude/settings.local.json` |
| `scandinavian-design` | `.claude/skills/scandinavian-design/SKILL.md` | Third-party ([ericzakariasson/scandinavian-design](https://github.com/ericzakariasson/scandinavian-design)), installed via `npx skills add ericzakariasson/scandinavian-design` — the visual-restraint contract behind the Scandinavian retoken; its `scripts/*.js` verifiers are patched to launch the container's pinned Chromium (`/opt/pw-browsers/chromium`) instead of a system Chrome |
| `minimalist-ui` | `.claude/skills/minimalist-ui/SKILL.md` | Third-party ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT), installed via `npx skills add Leonxlnx/taste-skill -s minimalist-ui` |
| `design-taste-frontend` | `.claude/skills/design-taste-frontend/SKILL.md` | Third-party anti-slop frontend skill ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT; docs at [tasteskill.dev](https://www.tasteskill.dev/changelog)) |
| `redesign-existing-projects` | `.claude/skills/redesign-existing-projects/SKILL.md` | Third-party audit-first redesign skill ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT) |
| `design-system` | `.claude/skills/design-system/SKILL.md` | TypeUI `minimal` registry spec ([typeui.sh](https://www.typeui.sh/design-skills)), pulled via `npx typeui.sh pull minimal -f skill -p claude-code`; also mirrored at `.agents/skills/design-system/` |

## 8. Verification expectations

Before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

For the full local gate suite (what `pnpm verify` runs — required before
anything security-sensitive lands):

```bash
pnpm verify   # lint + rustfmt/full-feature Clippy + test:all
              #   + cargo +1.88.0 test --workspace --all-targets
              #   + ./scripts/battle-test.sh
```

CI lives in `.github/workflows/`:

- `ci.yml` — runs on `pull_request` and `merge_group`: TypeScript job
  (`pnpm bootstrap` + `pnpm lint` + `pnpm typecheck` + `pnpm test`) and
  Rust job (`cargo test --workspace --all-targets`, Rust 1.88.0). Merges
  to `main` go through the GitHub merge queue with these two checks
  required.
- `deploy-pages.yml` — on every push to `main`, builds `apps/pages` and
  publishes it to GitHub Pages via `actions/deploy-pages` (Pages source
  must be "GitHub Actions"). `scripts/deploy-pages.sh` remains as the
  manual/local fallback publisher.

CI is the merge gate, not the whole story: the heavier suites
(`pnpm verify`, integration/e2e, `pnpm audit:*`) stay local — git hooks
plus the commands above, supplemented by scheduled Claude Code sessions
documented in `docs/operations/agent-routines.md`. Run the relevant
`pnpm audit:*` gates (§3/§6) for changes touching auth, crypto, or
dependency surfaces.
