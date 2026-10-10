# AGENTS.md

Agent context for OpenSesame. This file is the canonical entry point for any
coding agent working in this repo — read it before spelunking.

## How a task starts

Start every goal in a copy-on-write worktree branched from `origin/main`,
fan independent slices through a workflow, and ship them as stacked pull
requests that squash-merge into `origin/main` once the required checks are
green. The procedure is §9. The checkout at `/home/codex/repos/opensesame`
is often mid-merge; write the task in `/home/codex/repos/opensesame-<topic>`.

## 1. What this is

OpenSesame is a private **authorization fabric for the agentic era**: a
dual-plane system with a **host/client** product topology (see
[ADR 0017](docs/adr/0017-host-client-product-topology.md)).

- **Host / authority plane (Rust)** — one native binary, `opensesame`
  (`apps/cli`), whose roles are subcommands ([ADR 0138](docs/adr/0138-self-issued-identity-one-native-host.md)):
  `opensesame host run` serves the Host API (`crates/gateway`, `:8787`:
  ConnectionRef → authorize → invoke → receipt), `opensesame daemon run` the
  local host agent (`crates/daemon`, `:18790`), `opensesame worker run` the
  workload connector host (`crates/worker`); linked under a helper's name it
  answers as that credential helper or browser bridge. Password-manager
  ecosystem bridging (KDBX, keepassxc-protocol,
  browserpass/gopass hosts, the Bitwarden consume-client) lives in
  `crates/kdbx-bridge`, `crates/provider-bitwarden` and the default-off
  `crates/pm-bridges` features — human/device/ops plane only, never
  agent-facing ([ADR 0052](docs/adr/0052-password-manager-ecosystem-bridging.md),
  [ADR 0053](docs/adr/0053-pm-bridge-binaries.md)).
- **Client plane (Rust → Wasm + TS)** — `client-core` E2EE sync +
  `packages/api-client` (Host API TS client). Browser extension
  `apps/browser-extension` (WXT), offline GitHub Pages PWA `apps/pages`, Client CLI `packages/cli` (binary `opensesame-id`), MCP
  servers `packages/mcp-client` / `packages/mcp-host`.
- **Identity plane (TypeScript)** — Identity API `packages/control-plane`
  (`:8788`, Hono + Better Auth + oidc-provider), mock upstream IdP
  `tools/mock-upstream-idp` (`:9090`).

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

## Cursor Cloud specific instructions

This repository ships a **Cursor-hosted Cloud Agent** environment (managed VMs —
not My Machines or a contributor’s local PC). Image and bootstrap live in
[`.cursor/environment.json`](.cursor/environment.json) and
[`.cursor/Dockerfile`](.cursor/Dockerfile) (`rust:1.88.0-bookworm`, aligned with
`rust-toolchain.toml`).

- **Grok Build** is installed on `PATH` as `grok`
  (`GROK_BIN_DIR=/usr/local/bin` in the Dockerfile). With
  `XAI_API_KEY` set as a Cursor **Runtime Secret** (or `GROK_DEPLOYMENT_KEY` where
  applicable), headless use looks like:
  `grok -p "…" --always-approve --output-format json`.
- **Kimi Code CLI** is installed on `PATH` as `kimi`
  (`KIMI_INSTALL_DIR=/usr/local` in the Dockerfile; binary at
  `/usr/local/bin/kimi`). Cloud agents use it for fix work with model alias
  **`kimi-code/k3`** (`-m kimi-code/k3` or `default_model = "kimi-code/k3"` after
  login). Sign in once per machine with the **Kimi Code (OAuth)** subscription
  device-code flow — not a Kimi Open Platform API key: `kimi login`. Full
  headless recipes, probe (`kimi -m kimi-code/k3 -p "say OK"`), quota detection,
  and Composer fallback: [`.cursor/kimi-code.md`](.cursor/kimi-code.md).
- **Never run `sudo`** in agent commands (see `.cursor/rules/no-sudo.mdc`). The
  image includes `sudo` for Cursor platform tooling only.
- **Never commit API keys** or other secrets; inject them through Cursor Secrets.

After checkout, `install` runs `.cursor/install.sh` (`corepack` + `pnpm install`
+ `cargo +1.88.0 fetch`). Prefer the shared cargo target dir documented in §9
when compiling Rust in Cloud Agents.

## 3. Command crib sheet

All scripts below are defined in the root `package.json` unless noted.

```bash
pnpm bootstrap           # install + db:generate + db:migrate + setup:hooks
pnpm dev                 # turbo dev (control-plane, identity-worker,
                          #   mock-upstream-idp, example-rp-alpha/beta/static-rp)
pnpm dev:pwa             # Pages vite on :5180, no backend
pnpm dev:cli             # native opensesame CLI; verb after --
pnpm dev:host            # host on 127.0.0.1:8787
pnpm dev:daemon          # daemon on 127.0.0.1:18790
pnpm dev:live-nats       # nats-server config in operator mode for live sessions
                          #   (minted per-session credentials, ADR 0167)
pnpm build               # turbo run build
pnpm typecheck           # turbo run typecheck
pnpm lint                # lint:artifacts + Biome gate for files changed from origin/main
pnpm lint:design         # control contract (docs/design/controls.md)
pnpm lint:all            # lint:artifacts + full-repository Biome + anti-slop audit
pnpm lint:anti-slop      # strict Oxlint anti-slop; nested configs/unused disables fail;
                          #   ratchets tools/quality/anti-slop-baseline.json
pnpm quality             # quality:test (scripts/lib + scripts/security tests) + quality:gate, :log-hygiene,
                          #   :packages and :app-core
pnpm quality:gate        # module size (400) + TS complexity; ratchets tools/quality/quality-baseline.json
pnpm quality:packages    # ADP cycles, phantom deps, SDP/CRP debt across both planes
pnpm quality:log-hygiene # console.* / hand-built pino / unscrubbed tracing subscriber in production code; ratchets
                          #   tools/quality/log-hygiene-baseline.json (ADR 0157)
pnpm quality:app-core    # shared-core gate (ADR 0133) over app-core + vault-core: no reach into an app, no React value,
                          #   no import.meta.env, no virtual module, node:* only in src/node, no browser global outside
                          #   src/browser (vault-core: none), no static import cycle, lazy-cycle ledger only shrinks;
                          #   and repo-wide, a seam its module exports for its owner and tests (the vault store's
                          #   body port, ADR 0160 §5a) is imported by no one else
pnpm quality:bundle      # build apps/pages, check tools/quality/bundle-budgets.json
pnpm quality:report      # all three as reports, no gating
pnpm test:anti-slop      # plugin RuleTester suite + installer-asset parity
pnpm test:rust-lint      # contract test for rustfmt/Clippy hook + verify wiring
pnpm lint:fix            # fix changed and staged files
pnpm test                # turbo test across every workspace test script
pnpm test:integration    # turbo run test:integration
pnpm test:e2e            # turbo run test:e2e; live suites require their URLs
pnpm test:security       # @opensesame/testing test:security
pnpm test:task-access    # scripts/test/task-security-battle-test.sh
pnpm test:redteam        # @opensesame/redteam promptfoo corpus against mcp-host, behind a stub Host/daemon
                          #   (the structural pact suite is that package's test:integration)
pnpm test:visual         # Playwright pixel baselines (@opensesame/visual-contract)
pnpm --filter @opensesame/pages storybook   # the design system's catalog on :6006, MCP at /mcp
                          #   (docs/design/tooling.md); build-storybook, typecheck:storybook
pnpm test:nats-dogfood   # scripts/test/nats-dogfood-test.sh (spins up real nats-server)
pnpm test:live-stack     # scripts/test/live-stack-test.sh (live OpenFGA/OpenBao/gateway)
pnpm test:bitwarden-oracle # scripts/test/bitwarden-oracle-test.sh — pinned official bw CLI and the
                          #   SignalR client Bitwarden's apps pin, against the bitwarden-compat surface
                          #   (ADR 0141, ADR 0148); fails, never skips
pnpm test:tailnet-sync:real # scripts/test/tailnet-sync-real-tailnet.sh — verify:tailnet-sync over a real
                          #   tailnet: pinned headscale + two tailscaled nodes (one on a kernel TUN), the drive
                          #   behind `tailscale serve`, Chrome's own Local Network Access gate; needs
                          #   /dev/net/tun + CAP_NET_ADMIN, fails, never skips (ADR 0144)
pnpm test:mtls           # scripts/mtls/mtls-test.sh — native transport-security + TS contract suites, no fixtures
pnpm test:mtls:integration # scripts/mtls/mtls-integration-test.sh — pinned nats-server / OpenBao / SPIRE / Caddy
                          #   fixtures (scripts/mtls/mtls-fixtures.sh); fails, never skips, when a fixture is absent
pnpm test:mtls:browser   # scripts/mtls/mtls-browser-test.mjs — Playwright clientCertificates against the
                          #   Identity plane's own TLS listener (verify-browser-cert), plus the static app with
                          #   no certificate and the Transport form
pnpm test:mtls:fixtures  # scripts/mtls/mtls-fixtures.sh fetch all + verify — sha256-pinned nats-server,
                          #   OpenBao, SPIRE, Caddy under .cache/mtls-fixtures/ (never a browser dep)
pnpm test:live-fixtures  # scripts/test/live-fixtures.sh — the nats-server pin + ntfy built from pinned
                          #   upstream source + live-turn (pion/turn, UDP/TCP/TLS), the servers
                          #   verify:live-join runs (ADR 0150 §6)
pnpm test:all            # typecheck + test + test:integration
pnpm test:2password-parity # scripts/test/2password-parity.mjs — every suite declared in
                          #   spec/conformance/2password-parity.json (CI: password-parity.yml)
pnpm test:connect-preflight # scripts/test/connect-preflight.mjs — every connector's real endpoints,
                          #   read-only: OAuth authorize + discovery, MCP metadata, API-key verify (ADR 0147)

# Test-depth suites (none of these are in `pnpm verify`)
pnpm test:coverage       # TS (v8; statements/branches/functions/lines floors 94/88/94/95, + 50% per-pkg lines)
                          #   + Rust (llvm-cov) — docs/validation/test-coverage.md
pnpm test:coverage:ts    # scripts/quality/ts-coverage-gate.mjs; floors ratchet, never lower
pnpm test:coverage:rust  # cargo llvm-cov --fail-under-lines/-functions
pnpm test:mutation       # Stryker (TS) + cargo-mutants (Rust), scoped high-value files
pnpm test:mutation:ts    # stryker run → artifacts/mutation/typescript.json
pnpm test:mutation:rust  # cargo mutants → artifacts/mutation/rust
pnpm test:fuzz:batch     # Jazzer.js long pass (FUZZ_SECONDS=300)
pnpm db:migrate          # @opensesame/database db:migrate
pnpm db:reset            # @opensesame/database db:reset
pnpm generate:openapi    # writes packages/control-plane/openapi.json
pnpm generate:sbom       # CycloneDX SBOM to sbom/bom.json
pnpm docs:index          # rewrite the generated tables in docs/adr, docs/security/audits and docs/evidence
pnpm verify              # lint + lint:anti-slop + test:anti-slop + quality + test:rust-lint
                          #   + audit:clippy (rustfmt, full-feature Clippy) + test:plugin-boundary + test:all
                          #   + cargo +1.88.0 test --workspace --all-targets
                          #   + ./scripts/test/battle-test.sh — full local gate

# Security/audit gates (scripts/audit/*-gate.sh; the fuzz passes are in scripts/fuzz/)
pnpm audit:cve-lite
pnpm audit:ast-grep
pnpm audit:clippy          # rustfmt + full-feature Clippy; pedantic/complexity denied
pnpm audit:osv
pnpm audit:cargo-audit
pnpm audit:gitleaks
pnpm audit:semgrep
pnpm audit:deepsec          # .deepsec pattern scan (+ AI process when credentials allow)
pnpm audit:daemon-deps      # daemon dependency budget (ADR 0048 §5)
pnpm audit:plugin-boundary  # opensesame-cli and the daemon never reach a plugin crate (ADR 0150 §7);
                            #   test:plugin-boundary is its negative control, and is in verify
pnpm audit:fuzz             # cargo-fuzz short pass over targets whose crates changed (not in verify)
pnpm audit:fuzz:batch       # cargo-fuzz long batch over all targets (not in verify)
pnpm audit:kani             # bounded proofs (scripts/audit/kani-gate.sh)
pnpm audit:miri             # UB checks (scripts/audit/miri-gate.sh)
pnpm audit:shuttle          # concurrency model checks (scripts/audit/shuttle-gate.sh)
pnpm test:fuzz              # Jazzer.js short pass (not in verify)
```

### Per-plane local run

**Identity plane:**
```bash
pnpm install
pnpm --filter @opensesame/mock-upstream-idp build
pnpm --filter @opensesame/mock-upstream-idp start        # :9090
export OPENSESAME_ENV=development OPENSESAME_ALLOW_DEV_DEFAULTS=1   # the dev claim pepper needs the opt-in, and it is 1 or 0
pnpm --filter @opensesame/control-plane start             # :8788
curl -s http://127.0.0.1:8788/v1/health/live
```

**Host plane:**
```bash
cargo build -p opensesame-cli     # ./target/debug/opensesame, or $CARGO_TARGET_DIR/debug/opensesame (§9)
source scripts/dev/local-env.sh   # dev mode, loopback URLs, 0600 dev keys; what dev:host, dev:daemon and dev:cli source
./target/debug/opensesame host run --listen 127.0.0.1:8787
./target/debug/opensesame daemon run --listen 127.0.0.1:18790
./target/debug/opensesame daemon status
./target/debug/opensesame login --flow device --no-browser --server http://127.0.0.1:8787

# Sealed store (pass parity; never agent-facing reveal). `opensesame pass …` is the
# older spelling of `opensesame vault pass …`; both run (session.rs rewrites the former)
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
# backup auth for GitHub HTTPS remotes: GITHUB_TOKEN (or GH_TOKEN) → GitHub App
# (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH) → `gh auth token`

# Tailnet device management (ADR 0169): the daemon holds the Tailscale credential
./target/debug/opensesame daemon tailnet connect --tailnet example.com \
  --oauth-client-id k123CNTRL --secret-file ./oauth-secret   # or --api-token
./target/debug/opensesame daemon tailnet pair --origin https://vault.example.com \
  --role manage --url https://desk.tail4c2e.ts.net           # prints code + link
./target/debug/opensesame daemon tailnet devices             # approve/rename/tag/routes/expire/remove/mint/revoke/audit
./target/debug/opensesame daemon tailnet unpair --all
```

**Pages (offline PWA) — local debug (attached HMR):**
When the human says run the app locally, attach a live debug session. Do
not hand off a URL, a `preview` of `dist/`, or a headless `verify:*` run.

```bash
pnpm dev:pwa             # vite --port 5180 --strictPort --host localhost
# Keep this process attached. Open http://localhost:5180 (localhost, not
# 127.0.0.1, for passkeys). Watch console, pageerror, and failed requests.
# Patch source so Vite HMR updates the same session; do not restart from
# dist/ unless a merge-gate build was requested.
pnpm --filter @opensesame/pages dev       # full stack: Host :18787 + Identity :18788 + mock IdPs :9090-:9094 + Vite
```

**Pages as a static front end, no backend (ADR 0090) — run before touching
sign-in, setup, settings defaults or anything on the boot path:**
```bash
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:static
# Drives dist/ under https://tyler-r-kendrick.github.io/OpenSesame/ in
# headless Chromium: first screen is the front door's two roads + the guest
# Skip (no setup wall, no sign-in), guest walks every section, Google via a
# mocked shoo.dev lands unlocked once setup is skipped, deep links resolve. Fails on any page error, console error, loopback request,
# missing asset, or on-screen "No Identity API" copy.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:mobile
# Same harness, the phone journey (DESIGN.md § Touch): 320, 390, 430 and
# landscape (then a tablet, portrait and landscape), in a real coarse-pointer
# context. Every interactive control is
# 44px, no form control is under 16px (iOS zooms a smaller one on focus and
# never zooms back), nothing floating rests on a control, the statusline is
# one row, the sections sit in a drawer, the chrome stays under a third
# of the screen, and no strip hides its own selected item; a settings file
# opens at every width (list above the file, 44px rows, one size for the
# painted copy and its textarea, a long line scrolls the stage not the page).
# Run before touching layout, chrome, controls or any of the CSS under
# `(pointer: coarse)`.
# `MOBILE_SIZES=320,390` (names from `lib/mobile-contract.mjs`) walks only those
# sizes, which is how CI shards it; an unknown name fails, unset walks them all.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:auth
# Same harness, the authentication flow (ADR 0091): a guest presses Add on the
# authenticator row and is walked through a key first (the PIN card, in the
# same sheet), then scan, then a code computed from the setup key on screen,
# then the recovery codes; lock → only the PIN tab, code announced as step 2 →
# PIN → code → open, again after a reload; and a password-sealed vault the
# same way. Run before touching unlock methods, second steps or the unlock
# screen.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:device-identity
# Same harness, the device as the Identity plane (ADR 0160), a guest with no
# Identity API at desktop and phone widths: no sign-out row until the device
# has a session, the status reads "This device", the session's principal is
# the vault key's thumbprint and survives Refresh, every Settings section and
# Access tab reads clean, and Receipts is drawn only once Browser-local IAM
# serves an audit trail. Run before touching `identityPlane`, `identityServes`,
# the device host, or a panel gated on the Identity plane.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:device-inbox
# Same harness, the device's receipts, inbox and local notifications (ADR 0162)
# in a vault with no Identity API and no Host, at desktop and phone widths: a
# request raised and shown on the tab, told to a second tab (title, bell, one
# system notification carrying only { kind, action, ref }), approved and refused
# with the keyboard and the passkey, every decision a receipt in Sessions, an
# application signed in and revoked, and a locked vault showing nothing and
# answering 423. Own CI job, required through Bundle budgets. Run before
# touching `device-receipts`, `device-inbox`, `local-notifications` or Receipts.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:tutorials
# Same harness, every tutorial (ADR 0163): the Support sheet's Tutorials tab
# lists them, each is started from its row and walked with Next alone — the
# mouse on one step, Enter on the next — on the shell with every optional
# capability switched on, and on the gates (ADR 0166: the front door, setup,
# sign-in, unlock, the broker popup and the federation return each draw a help
# key and offer the tutorials written for them), at desktop and phone width.
# Each gate's key is held to the ADR: one icon key in the screen's chrome, 44px
# on a phone, resting on no control, reachable by Tab, never holding the focus
# on arrival. Every step's card must sit inside the screen with
# Next present, and a step that points at a control must light it, leave it
# uncovered and reachable through the aperture. Then Back, Replay, Done, and
# where focus went. A control that is missing is a failure here although a
# person would see it degrade to text. Run before touching a tutorial, the
# tutorial card, the Support sheet or the target registry.
# `TUTORIALS_SHARD=k/n` walks the kth of n slices of the library (by tutorial id);
# slice 1 also runs Escape, the move and the gates. CI runs three per width.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:encrypted-search
# Same harness, Encrypted search (ADR 0175) in the built app, at desktop and
# phone widths: with the capability off, retiring a password writes the sealed
# `opensesame-password-history` and the item's id is readable in it (the
# control); switching it on moves that database across and deletes it; a sweep
# of every record of every database then finds no item id, store, index or
# field name and none of the retired passwords' digests; each encrypted
# database is one store `r` and one index `x`, every record `osr2.` plus its
# entries; and a password retired before the switch is still refused as used
# before, found through a blind index. Run before touching `lib/encrypted-db/`,
# the history-backup or password-history stores, or `ports.keyRange`.
LIVE_OWNER=chromium LIVE_JOINERS=chromium,firefox,webkit \
  pnpm --filter @opensesame/pages verify:live-join
# Same harness, live sessions (ADR 0150, ADR 0187) in real browser contexts over
# real WebRTC, every walk once per joiner browser: the owner in LIVE_OWNER, the
# joiners in LIVE_JOINERS (chromium, firefox, webkit as the pinned Playwright
# installs them: `pnpm exec playwright install --with-deps chromium firefox
# webkit`; PLAYWRIGHT_CHROMIUM may point Chromium elsewhere). A walk an engine
# cannot take here prints NOT TAKEN with why (lib/live-engines.mjs). CI runs it
# as "Live join (<owner> owner)", three shards with every joiner each, folded
# into the required Bundle budgets check. Needs a second build first: `pnpm --filter @opensesame/pages
# build:live-dedicated` (dist-live-dedicated, stamped `dedicated_origin` for
# https://opensesame.example.test). The carrier and declined walks run on it,
# because a carrier on loopback or a LAN is local operator authority the shared
# github.io origin may not reach (`mayPairLocalAuthority`); verify:live-join
# fails without that build. Direct: codes passed by hand, no WebSocket, no request off the
# origin, no ICE server. Tunnel: mDNS on and only the tunnel address (this
# machine's default-route address) routes — never meets without Routes' address,
# meets at it with one. Carriers: an
# in-process Nostr relay, aedes MQTT, a real nats-server (the mTLS fixture
# pin), a real ntfy (LIVE_NTFY_SERVER, default .cache/live-fixtures/bin/ntfy)
# and BroadcastChannel each pair with nothing pasted and see no plaintext; a
# joiner who declines is never heard of. Relayed: relay-only through a real
# TURN server, relay to relay, over UDP (node-turn), TCP (`turn:…?transport=tcp`)
# and TLS (`turns:`, a self-signed certificate trusted by its public key alone)
# on live-turn (pion/turn, scripts/test/live-turn), whose per-transport counters
# show which one carried the browsers; and through a TURN REST secret typed into
# `settings/live/transport.json`, opened from the key on the Routes heading (the
# app mints the credential, the link never carries the secret; a wrong server
# secret must fail). Where a pair holds WebKit, which like Safari refuses plain
# loopback from https, each carrier is reached through a TLS front. A missing server fails the run
# (LIVE_CARRIERS / LIVE_SCENARIOS narrow it; `pnpm test:live-fixtures` builds them). Run
# before touching lib/live, the join road, Routes or sharing.live. Operator
# guide: docs/operators/live-sessions.md.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:live-netns
# The tunnel walk on a real network path: two Linux network namespaces
# (unprivileged user namespaces; no root, no sudo, no `ip`), a Chromium in
# each, a veth with multicast off between them and a harness namespace that
# forwards nothing. mDNS hiding on, nothing filtered in the page. No address
# named: never connects. Address named: connects over a pair at it, no ICE
# server (both on the github.io build). Then, on `build:live-dedicated` (run
# it first; the relay and TURN server sit on a private address): again through
# a wss Nostr relay; and, veth down, relay-only TURN.
# Fails, never skips, without namespace support. Run before touching
# lib/live/candidates.ts or the address hint.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:push-worker
# A real localhost origin with service workers allowed (`context.route` never
# sees a worker's fetches, and the shared harness blocks workers). A device
# holding the core `sw.js` approves Push notifications and must end on
# `sw-push.js` at the same scope: one registration, no reload, the vault still
# open; a push delivered over CDP rings the `{kind, action, ref}` doorbell and
# a hostile payload only the generic one; removing the capability returns the
# core worker. A second tab stays open throughout, and a replacement Chrome
# leaves waiting is asked for again under a fresh `?r=` URL, with no nudge. Run
# before touching the worker controller, `src/sw*`, or anything on the push
# enrolment path (`lib/push*.ts`).
pnpm --filter @opensesame/pages build:push-verify    # second Pages build into
                          #   dist-push-verify, stamped loopback_development for
                          #   http://localhost:41877 (the one origin that profile
                          #   honours); the tracked security-profile.json is put
                          #   back whether the build passes or fails
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:push
# Web Push end to end against a real Identity API (control-plane
# `startServer()` in memory on :41878, the Host's Web Push delivery, and a
# stand-in push service that verifies RFC 8292 VAPID and decrypts RFC 8291
# aes128gcm); runs under tsx. Only the browser's own subscription is stood in
# for. Walks approve Push, turn on (the server records the browser's
# subscription), a real push through the stand-in rings the closed doorbell,
# turn off (the row is gone), and the failures: service unreachable, an
# endpoint another principal holds (409, recovered), an account at its limit
# (409, nothing left half-enrolled, a held subscription the server cannot record
# is let go) and an operator policy that refuses the Identity API's origin. About
# 20 s. Run before touching `lib/push*.ts`, `modules/notifications.web-push`,
# or the control-plane, notification-adapters, identity-worker and database code
# the walk imports; CI runs it as its own job, "Web Push end to end", whenever
# the Pages build or any of that server code changes (`push` area in
# `scripts/lib/ci-changed-areas.mjs`).
```

Sealed-store manifest bridge (ADR 0037 §6): `opensesame pass seal manifest.json --shred`
encrypts a Pages plaintext path manifest into the store and `opensesame pass backup`
pushes ciphertext to the git remote. The Pages Import sheet reads such a manifest and
merges by store path (idempotent), never duplicates. The writing half
(`storeManifestFile`, `packages/app-core/src/sections/vault/import/store-manifest.ts`)
has no caller outside tests, so no Pages control exports one today.

Server-side backup (ADR 0039): gateway-held secrets need no CLI at all —
register the GitHub App (`POST /api/v1/providers/github/app`), install it on
the org, then `PUT /api/v1/backup/target` once. Every credential/sync/vault
mutation broadcasts an outbox event; the gateway's backup actor persists a
full ciphertext snapshot to the repo with compensating retries/suspension.
## 4. Layout map

Top level: `apps/` (deployables), `crates/` (Rust libraries), `packages/`
(TypeScript libraries and services), `examples/` (runnable integrations on the
public SDKs and shared contract packages, never an app's source), `marketplace/` (vault item-type definitions: `item-types/builtin/` is
embedded by both planes, `item-types/optional/` is indexed by
`.opensesame/marketplace.json`), `spec/` (WIT, Host OpenAPI, OpenFGA model,
connector manifests, and the shared config, conformance vectors, plugin
catalog, log-scrub rules, secret-file and agent-hooks contracts), `tests/`
(cross-cutting suites and shared fixtures),
`tools/` (lint plugins, quality ledgers in `tools/quality/`, mutation configs,
scanner rules, the mock IdP), `scripts/` (what `pnpm` tasks run, one folder
per purpose: `quality/`, `audit/`, `fuzz/`, `test/`, `mtls/`, `release/`,
`dev/`, `wallet/`, `security/`, shared logic in `lib/`), `ops/`
(compose, GitHub governance, ingress, NATS, routines), `skills/`, `patches/`
(pnpm patches for third-party dependencies), `docs/`. Each has a `README.md`
(`patches/` has none); `docs/getting-started/repository-tour.md` says where things go.
Do not add new top-level directories or loose root files — find the group.

| Path | Role |
|------|------|
| `crates/core`, `crates/host-core`, `crates/client-core` | WIT/Wasm polyglot core + product-SDK facades |
| `apps/cli` | **The native binary**, `opensesame` (`opensesame-cli`): every CLI verb incl. `pass`, and the roles `host run`, `daemon run`, `worker run`; `src/entry.rs` answers as each helper under its link name (`opensesame helpers link`) |
| `crates/gateway` | Host API library, `:8787` (`opensesame host run`); signed provider callbacks at `/webhooks/{connection}/{route}` (`src/callback_ingress`) |
| `crates/gateway/src/web_login`, `src/agent_hooks.rs`, `src/agent_hook_approver.rs`, `src/routes/{agent_hooks*,agent_runs*,web_login_recipes*}`, `src/retention.rs` | The Host's side of agent-hooks (ADR 0159): the web-login runner that spawns and tracks each run (`registry`), claims its job atomically, drives `run_change_password_hooked` with the organization's interceptor and a per-run approval seam, closes the run durably before settling, and is mopped up by the `reaper`; the typed canonical settle route (`agent_runs/outcome.rs`); `POST /api/v1/agent-hooks/intercept`, policy (`If-Match`, step-up in `agent_hooks/step_up.rs`), presets, approver, decisions and hook-records routes; recipe and signer routes; retention |
| `crates/daemon` | Local host agent library, `:18790` (`opensesame daemon run`); its dependency budget is `pnpm audit:daemon-deps` |
| `crates/worker` | Workload connector host library (`opensesame worker run`, ADR 0132) |
| `crates/storage` | SQLite-backed host store; `impl Db` is split one module per responsibility (ADR 0093) |
| `crates/storage/src/{agent_hook_policy*,agent_hook_records.rs,web_login_runs*,runner_steps.rs}` | Agent-hooks and web-login storage (ADR 0159): the policy (compare-and-set), the approver setting, the append-only decision audit, hook records that belong to their run (migration 0053), the step queue, the recipe writer that derives trust inside its transaction and the signer pins (0054), approvers (0055), job claims and retention |
| `crates/sealed-store` | Git-native hierarchical sealed secret store (`pass` parity) |
| `crates/lifecycle` | Expiry ladder, subjects, and frozen hook event names — pure, value-blind (ADR 0074) |
| `crates/security-events` | Shared security-event envelope, severity ladder, and Alertmanager v2 / `PagerDuty` v2 / RFC 5424 renderers — pure, no I/O (ADR 0080) |
| `crates/breach-intel` | Value-blind breach detection: Pwned Passwords k-anonymity, public breach-catalogue matching, frozen `breach.*` events (ADR 0080) |
| `crates/agent-events` | Frozen `agent.*` vocabulary for sandboxed runs, and the `SecurityNotice` conversion that puts them on ADR 0080's feed — pure, value-blind (ADR 0081) |
| `crates/agent-hooks` | OpenSesame as an [agent-hooks/0.1](https://github.com/responsibleai/agent-hooks/blob/v0.1.0-alpha.5/spec/AGENT-HOOKS-0.1.md) interceptor on the canonical `agent-hooks-sdk` core (pinned exactly): operator tool rules and §5.4 result labels at `pre_tool_call`, a value-blind secret guard that redacts credential shapes at every content seam and denies them in tool arguments, an approval resolver bound to `context_identity` as ADR 0086's request digest, and the Interaction-backed approver (`src/interaction`: requester-visible decline, withdrawal, digest recomputed against `spec/conformance/request-digest-vectors.json`, an `ask` its caller cannot cancel); `opensesame hooks intercept` is the out-of-process form (ADR 0159) |
| `crates/human-vault` | E2EE envelope crypto shared by vault + sealed-store, and `pages_vault`: the Rust reader of the vault Pages writes (vault format v1, checked against `spec/conformance/vault-vectors.json`), behind `opensesame vault verify\|ls` |
| `crates/session-observe` | Live observation of sandboxed agent runs — one sealed log (live tails, replay seeks), fail-closed frame admission, single-holder control lease (ADR 0081) |
| `crates/ceremony` | Connector registration ceremonies — the C0..C3 tier ladder, typed capture slots that fail closed, and ADR 0082 §5's refusals as types (ADR 0082) |
| `crates/a2h` | A2H (Agent-to-Human) v1.0 client — envelope, intent mapping, callback verification; a reply may only narrow authority (ADR 0081 §6, §9) |
| `crates/rotation-web` | Web-login rotation: the step IR, the tool boundary (no method returns a credential value), and the ordering that must not be rearranged (ADR 0076); plus the same boundary read backwards — `CeremonyTransport`'s capture verbs, which seal what a page produced and answer with a digest (ADR 0082 §3); `src/hooks` is the agent-hooks/0.1 **host** (every verb bracketed, authority pinned, no lock across an approval, `Refused` vs `Withheld`; CTK claims A and B in `docs/validation/agent-hooks-conformance.md`) and `src/recipe_doc` the signed recipe document (ADR 0159) |
| `crates/vault-item-types` | Host-plane item type parser, registry, and native-secret projection; embeds the shared definition corpus (ADR 0087) |
| `crates/tailnet-admin` | Tailnet device management, daemon side (ADR 0169): the Tailscale credential (0600, never sent to a page), origin- and role-bound page pairings, value-blind audit, validation, and the Tailscale API v2 client through `invoke-through`; `/v1/tailnet/*` routes in `crates/daemon/src/tailnet_admin_*.rs`, CLI `opensesame daemon tailnet`, replayed by both planes against `spec/conformance/tailnet-admin-protocol.json` |
| `packages/app-core/src/lib/encrypted-db/`, `apps/pages/src/modules/storage.encrypted-search/` | Searchable encryption over IndexedDB (ADR 0175, optional `storage.encrypted-search`): one object store and one multi-entry index hold every table, so no table, column, index or key name is on disk; rows are sealed, padded and keyed by a hash; CryptDB's layers run as blind indexes built on the first query that needs them (`eq`/join group, Boldyreva-style `order`, `keyword`/prefix) and dropped completely. `history-backup-*` and `vault/password-history-*` answer through a store seam the module points here, moving what the device-sealed databases held and deleting them. `names.ts` is core: Reset this browser derives the hashed database names from it |
| `packages/app-core/src/lib/tailnet-admin/`, `apps/pages/src/modules/networking.tailnet-devices/` | Identity › Devices for the tailnet's real machines (optional `networking.tailnet-devices`, needs `networking.tailnet` + `identity.local-iam`): sealed pairing, the daemon client, approve/rename/tag/routes/exit node/expire/remove, Add a device (auth key shown once), auth keys, activity. Refused on the shared-origin demo. End to end: `pnpm --filter @opensesame/pages verify:tailnet-devices` (real daemon + Tailscale stub + dedicated build) |
| `crates/connection-detect` | Value-blind, capability-moded credential discovery (ADR 0047/0048; serde+thiserror+std budget) |
| `crates/uds-authn` | UDS peer-credential attestation, same-user allowlist (ADR 0048 §8) |
| `crates/tailscale-authn` | Tailnet caller identity via tailscaled LocalAPI whois (ADR 0048 §8) |
| `crates/invoke-through` | Memory-resident invoke-through broker — egress allowlist, no redirects (ADR 0048 D6/D7) |
| `crates/transport-security` | Native TLS for the authority plane — rustls listeners/clients, `TlsIdentity` / `TrustBundle`, atomic `TransportGenerations`, SPIFFE and RFC 9525 verifiers; `testkit` feature issues disposable PKI for tests (ADR 0132) |
| `crates/domain/src/transport` | Pure transport contracts — `TransportPolicy`, `ServiceBindingSet` (default deny, exact selectors), non-deserializable `VerifiedPeer`, status views, stable error codes; TS mirror in `packages/os-domain` / `packages/contracts` (ADR 0132) |
| `crates/spiffe-source` | SPIFFE Workload API X.509-SVID source → `TransportGenerations`; exact configured SPIFFE ID, per-domain bundles, snapshot replacement; SPIRE is an optional issuer (ADR 0132 §2) |
| `crates/ingress-evidence`, `packages/ingress-evidence` | RFC 9440 `Client-Cert` / `Client-Cert-Chain` bounded parsing; accepted only from a bound ingress on a `trusted_ingress` listener (ADR 0132 §8) |
| `crates/nats-callout` | Native `$SYS.REQ.USER.AUTH` bridge (`opensesame-nats-auth-bridge`) — NKey/JWT verification, request/response binding; a high-trust component, narrowly bound to the Host (ADR 0132 §8) |
| `crates/gateway/src/transport`, `crates/gateway/src/transport_lifecycle` | Host transport runtime — config, admission (`ServiceCaller`, `require_service_caller`), bindings CAS, status, verify probe (`transport`), and trust, certificate, revocation and renewal routes (`transport_lifecycle`), all under `/api/v1/operator/transport/*` (ADR 0132) |
| `ops/ingress`, `ops/nats` | Vendor-neutral reference configurations — Caddy trusted ingress; NATS client-mTLS (`verify`) and certificate-mapping (`verify_and_map`) profiles plus the one tested server-to-server topology (ADR 0132 §8) |
| `tests/mtls-interop` | Real-protocol interop crate (`opensesame-mtls-interop`): Rust↔Node listeners, nats-server, OpenBao `auth/cert`, SPIRE, ingress; `#[ignore]`d unless `OPENSESAME_MTLS_FIXTURES=1` |
| `crates/credential-helpers` | git/docker/AWS/kubectl helpers — thin mint-path clients of the daemon, run as entry points of `opensesame` (ADR 0049) |
| `crates/bitwarden-server` | Bitwarden-compatible server, the `bitwarden-compat` cargo feature of the gateway and `opensesame` (off by default), mounted at `/bitwarden` when `OPENSESAME_BITWARDEN_COMPAT=on` — Bitwarden's own clients sign in (password, API key, authenticator), sync and edit personal vaults, attachments and Sends, organizations and collections, emergency access and key rotation, hear live sync on `/notifications/hub`, and optionally load an operator-supplied web vault; `opensesame bridge bitwarden import` moves vaultwarden servers and live accounts over; Argon2id client KDF by default and an Argon2id server hash behind a replaceable `HashRegistry`; `pnpm test:bitwarden-oracle` drives the pinned official `bw` CLI and SignalR client as the oracles (ADR 0141, ADR 0148) |
| `crates/kdbx-bridge` | KDBX 4.x read/write + mapping to sealed-store `Entry` (ADR 0052; not a daemon dep) |
| `crates/provider-bitwarden` | Bitwarden/vaultwarden consume-client — memory-resident session, host+TLS pinned (ADR 0052; not a daemon dep) |
| `crates/pm-bridges` | Local-IPC bridges (keepassxc-protocol, browserpass, gopass; `secret-service` and `webdav` features are declared but have no entry yet) — per-surface cargo features of `opensesame` (the first three), all default off (ADR 0052/0053) |
| `crates/domain`, `crates/authn`, `crates/authz`, `crates/grants`, `crates/broker` | Pure domain resources, invariants, IDs and errors; authentication flows (device authorization, loopback PKCE, workload, CIBA selection); OpenFGA relationships plus contextual constraints behind an AuthZEN-shaped API; the grant compiler; the invocation broker that checks a grant covers a frozen intent before anything runs |
| `crates/proof`, `crates/claims`, `crates/audit`, `crates/xkeys` | RFC 9449 DPoP validation and key custody; claim and device-code digests; signed invocation receipts; X25519 recipient seal/open AEAD for bus E2EE (never the Host connection seal key) |
| `crates/connection-broker`, `crates/connector-host`, `crates/connector-sdk` | Third-party authorizations held in the authority plane — callers get a `ConnectionRef` and status, never token material — with the connector catalogue in `src/catalog` (ADR 0032); the WIT connector host (authorized HTTP, signing, opaque token handles, no `secrets.get` for guests); WIT guest helpers |
| `crates/provider-openbao`, `crates/provider-openfga`, `crates/provider-static-mesh` | OpenBao adapter; OpenFGA remote PDP adapter; static service-discovery adapter (an in-memory endpoint map, not a TLS transport) |
| `crates/task-access`, `crates/task-bus`, `crates/relay`, `crates/sandbox`, `crates/enforcement` | Trust Ratchet task access engine; `TaskBus` trait with in-memory and optional NATS JetStream adapters; fail-closed admission rules for relayed execution (ADR 0046); bounded, brokered sandbox for general-authority guest execution; what a platform actually holds, and what it must refuse to claim |
| `crates/rotation`, `crates/env-spec`, `crates/pki-core` | Rotation state machine; the consumer of `@env-spec` JSON (via `packages/env-spec-bridge`); the provider-agnostic X.509 engine behind the certificate manager (ADR 0066/0067) — a pure library, no HTTP surface and no database |
| `crates/plugin-settings`, `crates/surrogate-proxy` | Optional runtime plugins: the catalog, the settings file that switches them and the install-time pins verified at every launch (ADR 0150 §7); the per-run surrogate proxy, shipped only as the plugin binary `opensesame-surrogate-proxy` (ADR 0150 §6.1) |
| `crates/protocol-mcp`, `crates/protocol-aauth`, `crates/authenticator-core`, `crates/collab-adapter`, `crates/dns-enforcement` | MCP Authorization Bearer-profile adapter; experimental AAuth draft-10 adapter (disabled by default); shared native authenticator policy, invocation validation and OTP core, with UniFFI bindings for `apps/android`; collaboration-platform authority adapter (a Discord guild's roles and channel overwrites, bot only); DNS-layer enforcement against Blocky |
| `packages/control-plane` | Identity API, `:8788` (Hono + Better Auth + oidc-provider) |
| `tools/mock-upstream-idp` | Deterministic mock OIDC upstream for local dev, `:9090` |
| `apps/pages` | Installable GitHub Pages offline PWA — the React shell over `@opensesame/app-core`: screens, sections, components, React bindings (`src/bindings/`), DOM/keyboard helpers, the service worker and the capability build (`src/lib/capabilities/{ownership,classification*,module-table,distribution}.ts`) |
| `apps/pages/src/tutorial`, `packages/app-core/src/tutorial` | In-product contextual support (ADR 0088) and tutorial mode (ADR 0163): the semantic target/route/predicate registries, the tutorial library (`registry/areas.ts`, one home per goal, one tour per Settings › Capabilities section in `registry/feature-goals.ts`) and the on-device and AG-UI transports live in the core; the support panel (Ask / Tutorials tabs) and the tutorial card (`coach/`: the dim and lit aperture, the step card with Back / Next, placement and focus) stay in the shell |
| `packages/app-core/src/lib/join/`, `apps/pages/src/screens/JoinScreen.tsx`, `apps/pages/src/screens/join/` | Join a session (ADR 0136): invite (link + out-of-band code) or open session at a named endpoint; approval (a browser pairing under the join-only `host.join` ceiling, renewed to a 30-minute sitting, provisioning no org role) → passkey verify → look up once per device → per-item consent → claim/ask; a public session may admit on ask, as an observer holding nothing (ADR 0137). The one Host-speaking ceremony in Pages; never writes `settings.hostApi`, never stores the code, never sends an offer's bearer to an endpoint it was not looked up at |
| `packages/browser-at-rest` | At-rest sealing outside Pages (ADR 0149): a non-extractable AES-GCM key per origin in IndexedDB and an async sealed view of any `StorageLike`; used by `sdk-browser`, `static-auth` and the extension |
| `packages/app-core/src/lib/at-rest/` | The at-rest seal (ADR 0149): the device key's states (`key.ts`), the seal (`cipher.ts`), sealed Web Storage, origin files and their boot sweep, and the browser's IndexedDB key store; the CLI's key file is `src/node/at-rest-key-file.ts` |
| `packages/log-scrub`, `spec/log-scrub/log-scrub.json`, `crates/redaction` | The one secret scrubber (ADR 0157): the spec holds the ordered value rules, the key-name rule and the vectors; the TypeScript package and the Rust crate each compile it and run every vector. `ScrubWriter` / `ScrubMakeWriter` scrub every Rust log line at the sink; `SecurityNotice::scrubbed()` and `sign_receipt` scrub events and receipts |
| `crates/sealed-log`, `packages/observability/src/sealed-log.ts` | The encrypted, rotating, owner-only log file (ADR 0157): every line sealed on its own (an `osl2.` envelope: XChaCha20-Poly1305, a fresh data key per line; legacy `osl1.` lines still read) under a key kept apart from the file; `OPENSESAME_LOG_FILE` replaces stdout on the Host, worker, daemon and TypeScript services; `daemon start`/`daemon logs` use and read it. One format, vectors in `spec/conformance/sealed-log-envelope-vectors.json` (`osl2.`) and the retained legacy `sealed-log-vectors.json` (`osl1.`) |
| `crates/event-seal`, `packages/database/src/event-seal.ts` | Event rows at rest (ADR 0157): the Host's SQLite events (`osev2.` text, a data key per value wrapped under a key HKDF-derived from `OPENSESAME_CONNECTION_KEY`; legacy `osev1.` is read only through startup migration; one process-wide sealer installed before anything writes) and the Identity plane's Postgres events (`withSealedEvents`, `{"$sealed": …}` jsonb, `OPENSESAME_EVENT_KEY` or the claim pepper). A networked or production Host, and a persistent database, refuse to start without their key |
| `packages/app-core/src/lib/nango-directory.ts`, `packages/app-core/src/lib/connector-directory.ts` | Connectors by reference: the Nango-compatible listing adapter (two routes, never a credential) and the directory's three homes — plaintext endpoint, sealed key + list, in-memory until a vault seals it (ADR 0115) |
| `packages/mcp-client` / `packages/mcp-host` | MCP servers (client- and host-facing), served by `opensesame-id mcp client\|host` |
| `packages/identity-worker` | Identity-plane background worker (TypeScript: outbox, webhooks, notifications, pruning) |
| `apps/browser-extension` | WXT browser extension; `runner/` is the local runner of the hosted step protocol (ADR 0159): claims steps with the person's Host session for an armed origin, executes them in an isolated-world injection, answers only canonical outcomes, submits at most once, and answers `failed(transport)` for the two capture steps no host envelope scheme exists for |
| `apps/browser-extension-autofill` | Optional companion extension, the `browser-autofill` plugin (ADR 0150 §7): fills a focused login field by reference after a gesture on its own UI, only on sites a person switched on; never in the default extension |
| `apps/android` | Native OpenID4VC holder/wallet through Multipaz: Android entry points under `android/`, the Apple wallet and Identity Document Provider sources under `ios/`, Kotlin and Swift bindings generated from `crates/authenticator-core` (`apps/android/scripts/build-core.sh`). Password, OTP and passkey provider behaviour is not part of it |
| `examples/*` | Example relying parties (`rp-alpha`, `rp-beta`, `static-rp`, `siop-rp`), agents (`agent`, `static-agent`) and a headless device-login client (`headless`) |
| `packages/app-core` | The client application core shared by the Pages PWA and the CLIs, with a sandbox host for a bare V8 isolate (ADR 0133; `apps/android` does not use it today): the vault store and its tombs, identity and federation, browser-local IAM, connectors, duress, SOPS, the WebMCP tools, the support registries and the screens' view-models (`*-model.ts`) — everything in the client that is not UI, laid out as `apps/pages/src` was. A shell plugs in through one host (`configureHost`, `src/host.ts`) whose ports (`src/ports.ts`: storage, page, authenticator, environment, locks, broadcast, worker, OPFS, IndexedDB) are read at call time, never at import (`src/no-host-import.test.ts`). Hosts: `src/browser/host.ts` (Pages installs it first thing in `main.tsx` via `apps/pages/src/host/boot.ts`), `src/node/host.ts` (the CLI; file storage, 0600) and `src/sandbox/host.ts` plus `sandbox/runtime-contract.ts` (a bare V8 isolate such as Android's JavaScriptSandbox; proven by `sandbox/bare-isolate.test.ts`). Gated by `pnpm quality:app-core` |
| `packages/app-core/src/lib/secret-fs/`, `packages/app-core/src/node/{secret-files,vault-directory}.ts`, `spec/secret-files/` | Secrets as files (ADR 0182), written on Effect 4: the `SecretFiles` contract (read/write/remove/list, revision = SHA-256, path rule, four typed failures), its backends — the emulation, a confined atomic directory over Effect `FileSystem` (Node layer in `src/node`), and an S3-compatible bucket (`s3.ts` over the `s3-sigv4.ts` signer; a browser needs no server of ours) — the `resilient` wrapper (attempt timeout, jittered retries, circuit breaker, lost-answer confirmation), the layout (`vault.json` manifest + `secrets/<folder>/<name>.<kind>.json`, one sealed document per secret), and `vfs-files.ts`, which lays the VFS seams (`vfs-seams.ts`) over any of them. One conformance suite per layer runs against every backend. The CLI keeps its vault at `<state>/vault/` through `useVaultDirectory`. Names are visible on disk by design; values never are |
| `packages/app-core/src/lib/keymap/{gestures,gesture-bindings,gesture-recognizer}.ts`, `apps/pages/src/lib/{gesture-runtime,gesture-motion,use-gestures,gesture-help}.ts`, `apps/pages/src/sections/settings/keybindings/{LoadoutTabs,GesturesPanel,GestureRow,MotionSwitch}.tsx` | The keymap's touch loadout (ADR 0170): a closed set of two-finger swipes, a two-finger tap and a shake bound to the same commands as keys through `runTarget` (never a command that asks first, never a register key); the pure recognizer (`RECOGNIZER`, `SHAKE`) in app-core, the touch handlers that claim only a bound swipe that began in a listing, and the motion sensor behind an Allow key where the browser asks first; Settings › Keybindings draws Keyboard and Gestures as tabs and opens on the device's own |
| `packages/app-core/src/lib/{device-receipts,device-inbox,device-identity-inbox}.ts`, `src/lib/local-notifications/`, `apps/pages/src/modules/notifications.local/` | The device's receipts, inbox and local notifications (ADR 0162): receipts are the vault's own sealed file (`device-receipts-store.ts`), apart from the Access audit, written after each decision and retried from a sealed pending list; the inbox is the pending local requests; the `audit` and `requests` device routes answer them to a session and decide nothing; `notifications.local` rings through the bell, the tab title and badge, and the Notification API (permission asked only on its key), routing narrowed to policy, no server and no push |
| `packages/vault-core` | The vault format kernel (ADR 0133): header, KDF and seals, unlock records, the item model and paths, TOTP, the offline-backup envelope, the vault-file reader (`openVaultFile`), the secret-drop format and the golden vectors (`spec/conformance/vault-vectors.json`, also read by the Rust reader `crates/human-vault` `pages_vault`). Depends on `os-domain` and `vault-item-types` only — no host, no storage, no platform; strict compiler base. Import from the root: `import { openVaultFile } from "@opensesame/vault-core"` |
| `packages/app-core/src/lib/item-type-marketplace/`, `packages/app-core/src/sections/settings/{virtual-files,item-type-files}.ts`, `apps/pages/src/sections/settings/files/` | Item-type marketplaces read from any git repository's `.opensesame/marketplace.json` (ours by default: `.opensesame/`, `marketplace/item-types/`, re-pin with `node scripts/release/pin-marketplace.mjs`), and Settings as files — the source view is a file viewer over `VirtualFileProvider`s and the Form is drawn from the same files (ADR 0134) |
| `packages/vault-item-types` | Vault item types: embeds the built-in corpus (`marketplace/item-types/builtin/*.json`), the closed field-type catalogue, the parser, and the runtime registry — one corpus for both planes (ADR 0087) |
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
| `packages/observability` | Structured logging + deep redaction |
| `packages/notification-adapters` | Channel adapters (Slack, Teams, Telegram, WeChat, SMS bridge, Web Push, generic webhook) — provenance verification, rendering, delivery; no provider logic anywhere else (ADR 0084) |
| `packages/capability-registry` | Agent-surface parity source of truth — every capability maps or ADR-excludes each of cli/pwa/mcp/webmcp (ADR 0065); parity tests in each surface package sweep it |
| `packages/webmcp` | WebMCP (`document.modelContext`, with legacy `navigator.modelContext` fallback) browser library — feature detection, fenced registrar for `apps/pages` tools |
| `packages/guide-lang` | GuideLang — the versioned tutorial language an in-product support model may write; parser, canonical serializer and validators. Deliberately cannot express a click, a selector or a URL (ADR 0088) |
| `packages/guide-runtime` | Deterministic GuideLang execution over ports only — no DOM, no renderer, no real timers; re-enforces every budget rather than trusting the parser. `auto` mode runs a model's trajectory to its next boundary; `tour` mode (`plan.ts`, `tour.ts`) walks a person through steps at their own pace — Next, Back, Replay, a step that degrades to text when its control is absent (ADR 0163) |
| `packages/support-agent` | Provider-neutral support port, semantic page context, system-instruction builder and the egress boundary — no React, no vendor model SDK |
| `packages/env-spec-bridge` | env-spec ↔ runtime config bridge |
| `packages/agent-client` | Agent-side exchange of an approved launch handle for a short-lived agent capability, over the daemon socket or the Host (ADR 0099) |
| `packages/capability-composition` | Pure, browser-safe capability composition: identities, policy documents, the deterministic resolver, reason codes, consent deltas and the lifecycle contracts every runtime and editor consumes (ADR 0130) |
| `packages/trust-broker` | The one evaluator for whether an approval stands: assurance, channel settlement and activation binding |
| `packages/siop-v2` / `static-auth` | Self-Issued OpenID Provider v2 (ID1) utilities — request parsing, ES256 Self-Issued ID Tokens, fragment responses; sign-in for static sites with no backend (hosted-identity, loopback and browser-local profiles) |
| `packages/qr` / `webhooks` / `telemetry` | QR encoding to SVG and terminal, with interaction-link encoders that refuse credential material; Standard Webhooks signing and verification and a public-only HTTPS sender; allowlisted anonymous product analytics (unknown events and props are dropped) |
| `packages/wallet-budget` / `wallet-consent` / `wallet-evm` / `wallet-mandates` / `wallet-policy` / `wallet-x402` | Wallet spending authority (ADR 0123): the pure budget journal (atomic reserve/commit/release, idempotent attempts); payment consent (intent, digest, digest-bound signature verification, export redaction); the EVM payment adapter foundation (fail-closed until a local-chain harness); AP2/UCP mandate codecs (fixture trust only); the spending-constraint vocabulary and enforcement assessment; the bounded x402 exact-payment profile |
| `skills/` | Agent skills — see §7 |
| `spec/wit/` | Polyglot core contracts (client, connector, core, host, mediation, proof, task) |
| `spec/openapi/host-api.yaml`, `spec/openfga/`, `spec/connectors/` | Host OpenAPI, OpenFGA model + baseline tuples, connector parity table and reference manifest |
| `spec/agent-hooks/` | `conformance/` is the agent-hooks CTK corpus vendored byte for byte from tag `v0.1.0-alpha.5` (47 vectors plus the golden identity file; exercised by `crates/rotation-web/tests/agent_hooks_ctk*.rs`) and `presets/` the named policies (`rotation-web-login`, `strict`, `observe`), embedded by both the CLI and the gateway with a drift test each (ADR 0139, ADR 0159) |
| `crates/storage/migrations/` | Host SQL migrations, embedded by `crates/storage` |
| `tests/fuzz/{cargo,jazzer,clusterfuzzlite}`, `tests/redteam`, `tests/visual-contract`, `tests/fixtures` | Fuzzing, MCP red team, visual regression, shared fixtures |
| `tools/quality/`, `tools/mutation/`, `tools/security/`, `tools/oxlint/anti-slop/` | Ratchet ledgers and budgets, Stryker configs, ast-grep rules and negative controls, the vendored anti-slop Oxlint plugin |
| `docs/` | Start at `docs/README.md`. `getting-started/`, `architecture/`, `adr/` (index generated by `pnpm docs:index`), `operators/`, `reference/`, `design/`, `security/` (audits in `security/audits/`), `validation/`, `evidence/`, `implementation/`, `research/` (competitors in `research/competitors/`), `contributing/`, `archive/` |

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
  `pnpm dev:pwa` on `:5180`. Procedure:
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
  It also Tabs onto a settings file's textarea and asserts the stage's focus
  cue shows (`apps/pages/scripts/lib/settings-file-keyboard-contract.mjs`). Keep this gate in the required Bundle budgets
  job; demonstrate failure before fixing a regression and success afterward.
- **A phone is not a narrow desktop, and the touch rules are gated on width as
  well as pointer.** The 44px floor, the 16px field floor that keeps iOS from
  zooming a focused field and never zooming back, the single-row statusline,
  the safe-area insets and the landscape arrangement are all measured by
  `pnpm --filter @opensesame/pages verify:mobile` against a fresh Pages build,
  at 320, 390, 430 and landscape, with a settings file open at each. Changes to
  the shell, the chrome, any shared control, or any block under
  `(pointer: coarse)` require it. A screenshot is
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
- **Web Push is proved against a real Identity API.** Changes to push
  enrolment, the push worker or its controller, the Identity API's push routes,
  the Web Push adapters or the Host's delivery require
  `pnpm --filter @opensesame/pages verify:push-worker` and `verify:push`
  against fresh builds (`build:push-verify` for the second). `verify:push` is
  its own CI job, folded into the required Bundle budgets check, and runs
  for the server code it exercises as well as for Pages. A push worker that is
  only ever shown to a mocked enrolment, or a walk that nudges the browser, is
  not evidence.
- `@opensesame/os-domain` **must not** import Better Auth, oidc-provider,
  Hono, Drizzle, or React (see CONTRIBUTING.md).
- Prefer mature libraries over NIH protocol code —
  [ADR 0008](docs/adr/0008-better-auth-oidc-provider.md).
- Do not add Clerk/Marketplace auth as core —
  [ADR 0004](docs/adr/0004-no-vercel-marketplace-for-core.md) (Vercel
  Marketplace *hosting* for previews is fine; auth is not).
- Identity API and Host API stay separate — no BFF merge —
  [ADR 0017](docs/adr/0017-host-client-product-topology.md).
- Record consequential decisions as ADRs under `docs/adr/`, numbered in order;
  `docs/adr/README.md` is the generated index of what exists.
- **The static front end is complete without a backend**
  ([ADR 0090](docs/adr/0090-static-frontend-complete-without-backend.md)).
  `apps/pages` is a broker, and nothing — no operator ceremony, no Identity
  API, no Host, no daemon, no localhost — may be placed in front of its first
  screen. On a device with no vault and no setup record that screen is the
  **front door** (`screens/FrontDoor.tsx`,
  [ADR 0115](docs/adr/0115-front-door-and-connector-directory.md),
  [ADR 0150](docs/adr/0150-live-sessions-browser-to-browser.md) §1): the
  wordmark at hero scale and exactly two roads made large — **Set up your
  own** and **Join a session** — with the guest road as the card's corner
  **Skip**. The door asks no sign-in question: a device with no vault has
  nothing to sign in to. Join is on every deployment, the shared GitHub
  Pages origin included: it opens a live session browser to browser over
  WebRTC, paired by codes the two people pass each other — no server, relay,
  STUN or TURN by default (`sharing.live`, `lib/live/`, consent first); an
  owner may name their own in Settings › Live sessions › Routes (a tunnel
  address, STUN/TURN, relay only, a Nostr/MQTT/NATS/ntfy carrier), never a
  default, and the joiner sees every host before any is contacted —
  and a Host invite link still opens the Host ceremony
  ([ADR 0136](docs/adr/0136-join-a-session-restored.md));
  a shared link opens join by itself. Once setup is answered or skipped the
  sign-in screen — the compiled-in Google-via-Shoo road and the local-only
  seal ("Use without an account") — is the first screen, and setup lives behind unlock
  (Settings), not as quiet foot links. The one thing a gate may draw beside
  its own chrome is a **help key** (`tutorial/gate-seat.tsx`,
  [ADR 0166](docs/adr/0166-gate-help-launcher.md)): a single icon key in the
  screen's chrome row, never in front of its content, its roads or the guest
  Skip, offline, opening the same Support sheet with only the tutorials written
  for that screen. No `setupRequired` gate on the setup record exists
  (`setup.test.ts` pins it) and none may come back. No
  default may point at a local host: `packages/app-core/src/lib/settings.ts` defaults are empty on
  every origin, and `127.0.0.1` addresses are suggestions a loopback tab may
  offer, never something the app assumes. With no Identity API configured a
  guest or federated sign-in is complete, not pending — no notice may name a
  service that is not there. A screen is gated on what it actually needs, one
  panel at a time (`useIdentityServes`, `useIdentityConfigured`; `useHostConfigured`
  in `apps/pages/src/lib/use-configured.ts` is a shim that always returns false,
  ADR 0128), never on "a backend":
  Access › Resources is Identity-plane and local-only, Sessions' receipts are
  Identity-plane, and gating those on a Host hid features that need none. A
  deployment that asks nothing may never report that something failed.
- **Nothing the client stores rests in the clear**
  ([ADR 0149](docs/adr/0149-nothing-stored-in-the-clear.md)). Every value
  written through the ports' `local`/`session` stores, `kv.ts` (OPFS),
  travel storage or `history-backup-idb.ts` is sealed under the host's
  at-rest key (`packages/app-core/src/lib/at-rest/`; a non-extractable
  IndexedDB key in a browser, a 0600 `at-rest.key` for the CLI) and bound
  to its store and name. Never write a browser global (`localStorage`,
  `indexedDB`, `navigator.storage`, `document.cookie`) directly, and never
  hand a third-party library a persistent browser store: MSAL runs on
  `memoryStorage` and runs no redirect or popup flow. With no durable key
  nothing reaches disk; do not add a plaintext fallback. Outside Pages — the
  extension, `client-core`'s sync store, `sdk-browser` and `static-auth` on a
  relying party's origin — values seal through `@opensesame/browser-at-rest`.
  `verify:static` reads the origin raw and fails on any app-owned value that
  is not `osr1.`.
- **A database that holds identifiers hides its shape too**
  ([ADR 0175](docs/adr/0175-searchable-encryption-over-indexeddb.md)). A
  readable index field, store name or record id is a name, whatever is sealed
  beside it. A new IndexedDB store of ids, names or principals is an encrypted
  database (`packages/app-core/src/lib/encrypted-db/`): one store `r`, one
  multi-entry index `x`, rows sealed under keys derived from the device key,
  searchable only through the layers its schema declares and built on the first
  query that needs them. Never add a store or index whose name says what it
  keeps, never index a digest or a secret-derived value (a shared entry shows
  reuse), and add the logical name to `EDB_LOGICAL_NAMES` so Reset derives it.
  The two existing stores answer through `HistoryRowStore` and
  `PasswordDigestStore`, which the optional `storage.encrypted-search`
  capability points at encrypted databases; the capability's module is the
  only importer of the library.
- **Logs and events carry no secrets, by key or by shape**
  ([ADR 0157](docs/adr/0157-logs-and-events-carry-no-secrets.md)). Redaction
  by key name alone misses a bearer in an error message, a `#token=` in a URL,
  a JWT in a stack trace and a DSN with a password in it, so every log line,
  event, audit row, activity entry and persisted failure passes the shared
  scrubber (`spec/log-scrub/log-scrub.json`, run by `@opensesame/log-scrub` and
  `crates/redaction` against the same vectors). Add a shape by adding a rule
  and a vector to the spec, never to one target. Log through `createLogger`
  (TypeScript) or a subscriber whose writer is `ScrubMakeWriter` (Rust); never
  `console.*`, a hand-built `pino(...)` or a bare `tracing_subscriber::fmt()`.
  `pnpm quality:log-hygiene` counts those and the ledger only falls. A struct
  holding a secret never derives `Debug`: write `impl fmt::Debug` and print
  `[REDACTED]` for it; `scripts/lib/secret-debug.test.mjs` (in `pnpm quality`) fails on a
  derived `Debug` over a field named like a credential. Log an id, never the secret.
- **Logs and events rest sealed** (ADR 0157 items 7–9). A log file a process
  writes goes through `crates/sealed-log` / `packages/observability`'s sealed
  destination (`OPENSESAME_LOG_FILE`); a new event or audit column the Host
  writes is sealed through `opensesame-event-seal` and read back through it (add
  it to `SEALED_COLUMNS` in `crates/storage/src/sealed.rs` so the legacy sweep
  reaches it); a new Identity event payload goes through `withSealedEvents`.
  Never write an event or a log line to disk in the clear, and never add a
  plaintext fallback: a configured sealed sink that cannot open refuses to
  start. The event keys derive from secrets the deployment already holds
  (`docs/operators/log-and-event-sealing.md`).
- **An authorization check is a proof the compiler can see**
  ([ADR 0178](docs/adr/0178-authorization-checks-are-proofs-the-compiler-can-see.md)).
  In the TypeScript plane, a function that needs "this actor owns this
  organization / holds this project role / is a verified principal / may write
  these shares" takes a `@gdp-ts/core` proof about the exact `Named` values it
  touches, minted only by a module under `proofs/` (`defineProof` is private to
  it and never exported). The checker returns a *verdict* (`proof | refusal`) so
  the route keeps its own status and message and the wire does not change. Do not
  write another `requireOwner`/`assertVerified`/`roleFor` that returns a boolean
  or a bare id; do not forge a proof with `as` (the Oxlint preset in
  `oxlint.config.ts` fails it); do not add a flag such as `bypassAccessCheck`
  where a `SystemShareWrite`-style typed choice belongs. Each proof gets a
  `*.mistakes.ts` of `@ts-expect-error` lines proving misuse does not compile,
  and tests obtain proofs from the real prover, never a cast. Where call sites
  disagree, name each behavior as an option and pin it; do not unify silently.
- Never expose raw secrets, private proof keys, or a public `getSecret()`
  affordance. Agent-facing APIs use ConnectionRef + Intent
  ([ADR 0005](docs/adr/0005-authority-handle-connectionref.md)).
- **Never remove or hide the guest/anonymous access flow** from the Pages
  sign-in and unlock screens — the one exception is the operator's own
  "Allow guests" switch in Settings › Capabilities
  (`packages/app-core/src/lib/guest-access.ts`, default on, fails toward on,
  turned off only by the device's operator, back on by anyone signed in but
  a guest; ADR 0135). Every placement reads it through
  `apps/pages/src/screens/unlock/GuestRoad.tsx`, `openGuestVault` refuses a
  guest session while it is off, and the last-vault pointer and vault list
  stop offering the guest tomb. It lives in two places and both are
  required: the front door's corner "Skip" (`screens/FrontDoor.tsx`, the
  door's one guest road, where a `/guest` link lands) and "Skip to the guest
  vault" in the unlock form's footer in
  `apps/pages/src/screens/UnlockScreen.tsx`, beside a sealed vault, including
  a guest tomb that enrolled a key. It is not drawn on the sign-in panel, and
  not beside a keyless guest tomb, where Unlock resumes that tomb and a second
  guest control would duplicate it. The sign-in panel
  (`screens/unlock/SignInPanel.tsx`) carries no guest road of its own: its
  single no-account road is "Use without an account", the local-only seal
  offered on first run (a full-size "Continue as guest" button, a corner guest
  Skip on that panel, and the unlock footer's old "Continue as guest" label
  were removed as duplication, 2026-10). The Identity sheet does not repeat
  that label: signed out, its no-account door is "Use this device"
  (`components/IdentityCeremony.tsx`), which connects this device and does not
  open the guest tomb. This flow has
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
  the tests in `FrontDoor.test.tsx`,
  `UnlockScreen.test.tsx`, and `store.test.ts` asserting guest exists and
  stays isolated are load-bearing
  and must not be deleted or inverted.
- **A new vault is sealed with a passkey, never a master password**
  ([ADR 0180](docs/adr/0180-vaults-are-sealed-by-passkey-not-password.md)).
  First-run sealing offers a passkey, or a PIN where WebAuthn cannot run;
  Settings › Security has no way to add or change a master password. A vault
  that already holds a password wrap keeps its Password tab (a header with no
  recovery is never stranded) and its Password row offers Remove only. Do not
  add a password field, strength meter or reminder to the seal form, and do
  not offer "Use a password instead" in a key sheet.
- A device knows two things and the unlock screen states both: **who** is
  signed in (the Identity session plus the upstream assertion federation saved)
  and **which key** opens the vault (the passkey/PIN/password wraps in the
  plaintext header, plus the manifest's verified recovery key, age key, age
  passkey and passkey capsule — never a cloud KMS record, whose credential is
  sealed in the vault, ADR 0152 — then the authenticator gate if enrolled). The
  unlock tabs are exactly the enrolled methods, never a uniform three; an enrolled
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
  PIN form anywhere. Email and text codes are fallbacks the
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
- **Every key is a person's, and a few keep the road open**
  ([ADR 0156](docs/adr/0156-keybindings-and-macros.md)). The shell's handler
  resolves every press through the effective keymap (the catalogue in
  `packages/app-core/src/lib/keymap/commands.ts`, overlaid by the person's
  sparse bindings), so a new key is a catalogue row, never a second
  hard-coded table. Tab, Enter, Escape, F6, Shift-F10/Shift-Enter and the
  count digits stay fixed. A command that asks before it acts (trash, share)
  never gains a key and never runs from a macro, and an event trigger
  (`on: unlock`, `on: enter:<section>`) runs navigation only. A key may be
  scoped to a closed set of contexts (`vault`, `rail`, read from
  `listingOf(event)`), never an expression, and every guardrail holds in each.
- **A Settings row acts, or it is not drawn**
  ([ADR 0158](docs/adr/0158-settings-rows-act-or-are-absent.md)). No disabled
  key, no lock glyph standing for "not yet", no link to a page that does not
  configure the thing, no static status a person cannot change. A control
  whose precondition is unmet is absent; the row that needs a setting opens the
  sheet that sets it. A setting is not removable while something depends on it.
- **Settings is files, and a page is how a file is seen**
  ([ADR 0134](docs/adr/0134-item-type-marketplaces-and-settings-files.md)).
  Configuration a Settings panel edits lives in a virtual file; a directory's
  `config.yaml` and the capability documents are those files, and **opening one
  draws the designed page that writes it, never its text** — the same as every
  other page. Never draw YAML as a view, never add a Form/Visual/Source toggle
  or a paste box, and when a key has no designed row, add the row (Capabilities
  adds the designed row on the page that owns the key; Host/Identity/daemon
  are not Pages backends and have no Endpoints panel). Only a file
  a provider keeps for authoring (an item type's JSON, `marketplaces.json`, a
  routing file) opens in the file viewer, painted in the same colours, from a
  row's key. An item-type marketplace is a git repository read through its
  forge's anonymous raw-file route; it confers no trust — every definition it
  offers meets ADR 0087's parser and registry — and it is read only when a
  person opens it.
- **Built-in item types beyond the core are packs, switched on to download**
  ([ADR 0165](docs/adr/0165-item-type-packs-on-demand.md)). Only `secret`,
  `file`, `passkey`, `certificate` and `drop` are embedded in the bundle; the
  other 23 are `packages/vault-item-types/src/packs/<id>.generated.ts`, each its
  own chunk behind a dynamic `import()`, indexed by `PACK_INDEX` (metadata and a
  SHA-256, nothing else). Settings › Vaults › Item types is a list of switches —
  the whole row is the switch, `role="switch"`, for a thumb. Switching on queues
  `enablePack` (`packages/app-core/src/lib/type-packs/`): download, digest,
  parse, sealed copy for offline, register — downloads a few ahead, installs one
  at a time, the main thread handed back between steps, no reload, state told on the row, in a live region
  and in the bell tray. Never import `*.generated.js` under `src/packs/`
  statically, and never read a pack's text from the entry; a type the open
  vault holds items of is installed for the document and has no switch. After
  editing `marketplace/item-types/builtin/*.json`, re-run
  `pnpm --filter @opensesame/vault-item-types generate`. A suite that assumes
  the whole corpus loads every pack in its setup.
- **A password is produced by one facade, and a pepper is never asked for or
  stored** ([ADR 0174](docs/adr/0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)).
  Copy, fill, the terminal, the daemon, health and export all call
  `producePassword` (`@opensesame/vault-core`; `produce_entry` in
  `crates/sealed-store`) and none knows how a password is made; `produce-facade.test.ts`
  fails on any other reader of an algorithm or a pepper position. *Include
  pepper* means the produced password has a slot for a secret of the person's
  own, at a Python-style `pepperAt`; the product holds no pepper, no envelope under
  one and no verifier for one. A file holds the parameters an algorithm computes
  from (generator, rules, counter, root) and an empty line one, never the generated
  password. A generator's label names a kind (*Algorithmic*), never a technique.
- A vault item type is a manifest, never a code path. Adding one is a JSON
  file in `marketplace/item-types/builtin/` (embedded by both planes),
  and a user can install one at runtime with no build. Fields name types from
  the closed catalogue; a concealed field may never reach `subtitle`, `search`,
  or a VFS filename; only a platform-published definition may name a ceremony
  handler ([ADR 0087](docs/adr/0087-vault-item-type-plugins.md)).
- **One definition, every target**
  ([ADR 0139](docs/adr/0139-one-definition-every-target.md)). Anything more
  than one target needs — an integration, a capability, a config key, a
  behaviour's test vectors — is written once under `spec/` and consumed by
  every target (embedded, or generated with a freshness test), with a drift
  test in each consumer. Never add a provider id, list or rule to one target:
  add the row to `spec/connectors/catalog.json` (aliases for other names),
  regenerate the view (`UPDATE_CATALOG_VIEW=1 cargo +1.88.0 test -p
  opensesame-connection-broker --test catalog_view`) and the client module
  (`pnpm --filter @opensesame/app-core generate:catalog`). A target shows a
  subset only as an ordered selection of catalog ids.
- **A surrogate selects a credential; it never becomes one**
  ([ADR 0150](docs/adr/0150-surrogate-credentials-at-the-last-hop.md)).
  An unmodified client may hold `osr_…` instead of a token, and the broker
  *recognizes* it, *strips* its header and *re-places* the credential into
  the provider's own site through invoke-through — never a find-and-replace
  of the text. A surrogate anywhere but its one declared site, at another
  host, from another caller, or outside its method/path scope is refused
  and is a `surrogate.*` tripwire; the client learns only one message.
  Surrogates carry no provider prefix. Every brokered response is scrubbed
  of the credential it carried. No extension or PWA does network
  substitution (ADR 0150 §6.4–6.5). The proxy, login-form substitution and
  autofill are **optional runtime plugins** (ADR 0150 §7,
  `spec/plugins/catalog.json`, `crates/plugin-settings`): never in the
  default `opensesame` binary, the daemon's dependency tree, the Pages
  bootstrap or `apps/browser-extension`; installed from a terminal with a
  sha256 pin re-verified at every launch; recorded off until switched on in
  Settings or `opensesame plugins enable`; `OPENSESAME_PLUGIN_<ID>=off` can
  only turn one off. A gate fails if `opensesame-cli` or the daemon reaches
  the plugin crate.
- A connector arrives by reference, never by credential. The connectors tab
  of setup and the Connections page's *Import connectors* read a
  Nango-compatible directory's two listing routes and nothing else; `GET /connection/{id}` — the route that
  returns tokens — is never called, no Nango package is depended on, and the
  directory's key is sealed in the tomb or held in memory, never written in
  the clear. Binding a connector to a person or agent is a local share grant
  of kind `connection` — the one ledger Identity shares use — not a second
  authority model ([ADR 0115](docs/adr/0115-front-door-and-connector-directory.md)).
  Access › Connectors lists access — connectors someone holds a grant on —
  and adds a grant by choosing a connector Connections configured or
  imported; it never asks for an endpoint, a key or a sync (ADR 0115,
  amended 2026-09-28).
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
  text reaches the document as a React text node on the tutorial card, which parses
  no markup. Page context is assembled from authored
  registries only, never from the DOM, so no secret, item name or folder name
  has a path into a prompt. A new control worth asking about gets a catalog
  entry with checked-in prose; a new authored guide is compiled by the same
  parser and validator model output goes through
  ([ADR 0088](docs/adr/0088-ai-native-contextual-support.md)).
- **Every feature has a replayable tutorial, and every tutorial is walked in a
  real browser** ([ADR 0163](docs/adr/0163-tutorial-mode.md)). A new section of
  Settings › Capabilities gets a `feature.<id>` target and a tour in
  `feature-goals.ts`; a new goal gets a home in `registry/areas.ts` (the test
  fails without one) and a step is a `say`, a pointing directive with the
  `wait` after it, or the closing `success` — every step must be reachable by
  Next alone, and must point only at controls that are drawn where the tutorial
  is offered (an authored tour may name up to 40 instructions; a model's stays
  at 8). A tutorial that points at a section or a signed-in-only row says so
  (`focus "feature.<id>"`, `requires`) and the library hides it where it
  cannot work. A control a guide can point at, and every key the keymap binds,
  is taught by a tutorial or named in `coverage-ledger.ts` with a reason
  (`coverage.test.ts`; the ledger only falls). A gate (the front door, unlock,
  setup, the broker popup, the federation return) draws a help key and starts
  tutorials scoped to its own route (`gate-goals.ts`, `useSupportRoute`'s
  `/unlock/door`, `/setup/identity` and the rest; ADR 0166), and is offered
  none of the shell's. Changes to a tutorial, the Support sheet, the tutorial card or
  the target registry require `pnpm --filter @opensesame/pages verify:tutorials`
  against a fresh Pages build (every tutorial, desktop and phone, Next and
  Back and Replay and Done, keyboard and mouse, focus handed back), and keep it
  in the required Bundle budgets job.
- **Every new user-facing feature is a capability, and an optional one never
  loads before consent**
  ([ADR 0130](docs/adr/0130-operator-controlled-capability-composition.md)).
  Most functions are **always-on** (`alwaysOn` in
  `catalog-always-on.ts` and `catalog-always-on-local.ts`, ADR 0135/0142):
  core tier, never a switch, code still loaded as a module after boot.
  The site broker and git backup are always on, not an opt-in the page
  reports as "deselected". Connections, Access and Identity are optional
  extensions, absent until their Settings switch is on, and the minimal
  vault creates only the base secret (ADR 0153). An operator's verified policy
  may still withdraw an always-on capability that owns a module (ADR 0142). Settings › Capabilities is **one
  list of sections** (`FEATURES` in
  `packages/app-core/src/lib/capabilities/features.ts`), every one drawn as a
  `conn-group` subheader plus its tiles; a section with optional capabilities
  carries its switch on the subheader (no card row, no collapsible, no
  second per-capability list), and every optional capability and connector
  family has exactly one section.
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
  against `tools/quality/quality-baseline.json` and `tools/quality/package-metrics-baseline.json`: a file
  may not exceed its recorded number, **and a file that improves must have its
  baseline tightened in the same commit** (`pnpm quality:gate --update`). Never
  raise a recorded number to make the gate pass — split the file. New files get
  a recorded number of zero, so new code meets the budget outright.
  `docs/validation/code-quality-gates.md` is the working guide.
- Pages, PWA, and ceremony UI follow [`DESIGN.md`](DESIGN.md) and
  [`docs/design/controls.md`](docs/design/controls.md).
  The visual tooling is three tools with three roles
  (`docs/design/tooling.md`): Storybook (`apps/pages/stories/`) *defines* the
  system and every delivered component gets a story on the app's own CSS;
  Figma *sets the look* a story must match through its Design tab; Stitch
  *prototypes* alternatives from `.stitch/DESIGN.md`. A story never restyles a
  component, and nothing moves from Stitch into `apps/pages` without a frame
  and a component first. An action that
  executes is an icon key (`icon-btn`, or `.go` for the action that ends the
  screen) with `aria-label` and `title`. Do not paint a verb on a button.
  Text on a control is only a choice object (a provider, a mode, a navigation
  target, the guest road). A status is a `StatusMark` glyph, never a text
  pill. **A failure is never drawn in the page**: no red box (`note--err`,
  a dynamic `note--${tone}`, `conn-error`, `conn-flash`, `broker__card--err`,
  any `*__error`/`*__err` paragraph), no visible `role="alert"`, no error
  wash on a block. It is a `StatusMark` on the row, field or receipt that
  failed *and* a notice in the tray (the bell): mount
  `<FailureNotice id title message />` (`apps/pages/src/components/FailureNotice.tsx`),
  call `useFailureNotice` (`apps/pages/src/components/use-failure-notice.ts`), or
  use `StatusNote`, which now trays every error and warning and draws only a
  quiet success. A screen with no shell (unlock, front door, federated return,
  an unframed popup) gets the corner bell, `NoticeCorner`, mounted by `AppRoot`
  ([ADR 0163](docs/adr/0163-failures-live-in-the-tray.md)). Do not add explainer or caption prose. Pages copy never
  names a Host, and a browser-local connector action never asks the person to
  pair one. `pnpm lint:design` (`scripts/quality/design-lint.mjs`) rejects word-verb
  buttons, status pills, explainer captions, and any in-page failure
  (`no-in-page-error`, `no-error-box-css`; no ledger, the count is zero); `impeccable detect`
  enforces the same design file. Both run in `.githooks/pre-commit`. The
  word-verb ledger is `tools/quality/design-button-baseline.json` and only falls.
  **Three shape rules gate every control, and each has a lint rule whose
  count is zero** (the corners ledger, `tools/quality/design-radius-baseline.json`,
  is empty and stays empty). *Corners are square* (`no-round-corners`): `--radius` is 0, and no
  `border-radius` past 0 — no 2px, no pill, no circle, no percentage — appears on
  anything; dots, knobs and spinners are squares. *A control is never red*
  (`no-danger-control`, `no-control-error-ink`): the error ink belongs to a
  status (`StatusMark`, the tray card, an `aria-invalid` border), so there is no
  `btn--danger`, `go--danger`, `icon-btn--danger`, no red armed key, no red
  menu entry; the one irreversible act is the ordinary `.go` square with the bin
  glyph, and `tone: "danger"` only picks that glyph and keeps the ask plain.
  *A sheet has one way out* (`one-way-out`): its close key in the head (with
  Escape and the scrim) is the only dismiss, so a `CeremonyShell` `secondary`
  that only says "Keep it", "Not now" or "Cancel" is a second X and fails;
  focus lands on the close key.
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
- `docs/security/audits/YYYY-MM-DD-<topic>.md` — a running series of
  point-in-time audit docs, each documenting a specific vulnerability that
  was found and fixed. Add a new dated file rather than editing history, then
  `pnpm docs:index` (the index is checked by `pnpm quality`).
- `docs/security/tooling-evaluation.md` — evaluation of the audit gate
  tooling.
- Gate scripts (invoked via the `pnpm audit:*` scripts in §3):
  `scripts/audit/cve-lite-gate.sh`, `scripts/audit/ast-grep-security-gate.sh`,
  `scripts/audit/clippy-gate.sh`, `scripts/audit/osv-scanner-gate.sh`,
  `scripts/audit/cargo-audit-gate.sh`, `scripts/audit/gitleaks-gate.sh`,
  `scripts/audit/semgrep-gate.sh`, `scripts/audit/deepsec-gate.sh`,
  `scripts/audit/daemon-deps-gate.sh`, `scripts/audit/plugin-boundary-gate.sh`,
  `scripts/audit/kani-gate.sh`, `scripts/audit/miri-gate.sh`,
  `scripts/audit/shuttle-gate.sh`.

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
except third-party installs (`impeccable` and the design skills below), which
are real directories there (and, for each, under `.claude/skills/` too) so
their own updaters can refresh them.

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
| `impeccable` | `.agents/skills/impeccable/SKILL.md` | Third-party frontend design skill ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), Apache 2.0), installed via `npx impeccable install` — lives in `.agents/skills/` (not `skills/`) so `npx impeccable update` can refresh it; design detector hook in `.codex/hooks.json` + `.claude/settings.local.json` (gitignored, machine-local) |
| `scandinavian-design` | `.claude/skills/scandinavian-design/SKILL.md` | Third-party ([ericzakariasson/scandinavian-design](https://github.com/ericzakariasson/scandinavian-design)), installed via `npx skills add ericzakariasson/scandinavian-design` — the visual-restraint contract behind the Scandinavian retoken; its `scripts/*.js` verifiers are patched to launch the container's pinned Chromium (`/opt/pw-browsers/chromium`) instead of a system Chrome |
| `minimalist-ui` | `.claude/skills/minimalist-ui/SKILL.md` | Third-party ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT), installed via `npx skills add Leonxlnx/taste-skill -s minimalist-ui` |
| `design-taste-frontend` | `.claude/skills/design-taste-frontend/SKILL.md` | Third-party anti-slop frontend skill ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT; docs at [tasteskill.dev](https://www.tasteskill.dev/changelog)) |
| `redesign-existing-projects` | `.claude/skills/redesign-existing-projects/SKILL.md` | Third-party audit-first redesign skill ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT) |
| `design-system` | `.claude/skills/design-system/SKILL.md` | TypeUI `minimal` registry spec ([typeui.sh](https://www.typeui.sh/design-skills)), pulled via `npx typeui.sh pull minimal -f skill -p claude-code`; also mirrored at `.agents/skills/design-system/` |
| `stitch-*`, `design-md`, `taste-design`, `enhance-prompt`, `site-md`, `stitch-loop` | `.agents/skills/<skill>/SKILL.md` (+ `.claude/skills/`, `.grok/skills/`) | Third-party ([google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills), Apache 2.0), installed via `npx skills add google-labs-code/stitch-skills --copy` for every agent target and pinned in `skills-lock.json`; Google Stitch prototyping over `.stitch/DESIGN.md` and the Stitch MCP server (`docs/design/tooling.md`) |

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
pnpm verify   # lint + anti-slop (lint and plugin tests) + quality gates
              #   + rustfmt/full-feature Clippy + plugin-boundary + test:all
              #   + cargo +1.88.0 test --workspace --all-targets
              #   + ./scripts/test/battle-test.sh
```

CI lives in `.github/workflows/`:

- `ci.yml` — runs on `pull_request`, and on every push to `main` and on demand.
  The required checks stay
  TypeScript, Bundle budgets, and Rust, and each name reports on every
  pull request (a skipped required check does not satisfy the ruleset).
  The suite behind a check runs only when the diff touches that area
  (`scripts/lib/ci-changed-areas.mjs`). Inside a suite,
  `scripts/lib/ci-affected-tests.mjs` tests the changed packages or crates
  and the ones that depend on them: TypeScript typechecks that set and runs
  the tests the diff reaches (`scripts/lib/ci-scoped-tests.mjs`: `vitest
  related`, plus every test that reads the filesystem; a package runs whole
  when a manifest, config or its test setup changed), and Rust runs `cargo
  test --all-targets -p` for that set on Rust 1.88.0. A root lockfile or
  manifest tests the whole suite. Bundle budgets builds `apps/pages` and
  checks `tools/quality/bundle-budgets.json`; its browser gates run as
  parallel shards of one matrix job (`bundle`: each shard builds Pages once
  and walks its own gates; `verify:mobile` is split by viewport with
  `MOBILE_SIZES`). The shard list is `scripts/lib/ci-bundle-shards.json`, and
  `scripts/lib/ci-gates.mjs` selects the shards and jobs a diff can break
  ([ADR 0176](docs/adr/0176-ci-runs-what-a-diff-can-reach.md)); a path it does
  not recognize starts every gate, and a push to `main` runs everything.
  `scripts/lib/ci-bundle-shards.test.mjs` fails on a gate that runs in no
  shard or in two, and `ci-gates.test.mjs` on a `verify-*` driver with no gate
  row. A new gate goes in exactly one shard, not appended to a serial list;
  "Web Push end to end" (`verify:push`) is its own job that the same check
  waits for, and runs when the Pages build or the server code it imports changes;
  so is "Live join" (`verify:live-join`, three shards, one per owner browser,
  each walking Chromium, Firefox and WebKit joiners), which also runs when a
  live server's source (`scripts/test/live-turn`, the fixture scripts) changes.
  The TypeScript check also waits on the signature preflight (the `changes`
  job), and its tests job runs changed-file lint and `pnpm quality`. The Rust
  check also waits on the Android and Swift native jobs when a diff touches
  native mobile code; the `mTLS` job is not a required check. A docs-only diff
  passes the three checks without those suites. An unrecognized path runs
  every suite.
  The ruleset also requires an up-to-date PR and squash auto-merge; this
  personal-account repository does not support merge queues. Verify
  actual settings with `node ops/github/governance.mjs --verify`.
- `deploy-pages.yml` — on every push to `main`, builds `apps/pages` and
  publishes it to GitHub Pages via `actions/deploy-pages` (Pages source
  must be "GitHub Actions"). A release marker and post-deploy HTTPS digest check
  prove the live HTML/runtime configuration matches the exact source SHA.
  `scripts/release/deploy-pages.sh` remains as the
  manual/local fallback publisher.
- `full-suite.yml` — typechecks and tests every TypeScript package on `main`
  daily (03:17 UTC) and on demand, so a red that no open diff reaches
  surfaces within a day. Not a required check.
- `password-parity.yml` — `pnpm test:2password-parity` (the 2password parity
  gauntlet) on pull requests that touch the CLI, Pages, the extension, the
  crates, `app-core`, `vault-core` and the other paths it lists, and on demand.
  Not a required check.

CI is the merge gate, not the whole story: the heavier suites
(`pnpm verify`, integration/e2e, `pnpm audit:*`) stay local — git hooks
plus the commands above, supplemented by scheduled Claude Code sessions
documented in `docs/contributing/agent-routines.md`. Run the relevant
`pnpm audit:*` gates (§3/§6) for changes touching auth, crypto, or
dependency surfaces. Host the work itself as §9 describes: a copy-on-write
worktree, a workflow swarm, stacked pull requests, a disk check after every
commit, then self-review and squash-merge.

## 9. Starting, parallelizing, and shipping a task

Every new goal follows this sequence. It applies to interactive sessions and
to the standing routines in `ops/routines/` (`docs/contributing/agent-routines.md`).

### Worktree

Fetch `origin/main`, then:

```bash
git worktree add -b <branch> /home/codex/repos/opensesame-<topic> origin/main
```

`git worktree` shares this clone's object database. Do not `git clone` a
second full copy of the repository, and do not nest the worktree inside
`/home/codex/repos/opensesame` or commit it as files of that checkout. Leave
a checkout with `MERGE_HEAD` set alone: do not commit, abort, or finish that
merge to make room for the task. One task, one branch stack. Leave unrelated
dirty worktrees, including `opensesame-dev-commands`, untouched.

### Shared caches

The disk stays near full. A new worktree gets source only.

- pnpm: install with the existing store (`pnpm store path`, the user store
  under `~/.local/share/pnpm/store`). `pnpm install` hardlinks from that
  store. Do not copy `node_modules` from another checkout.
- Cargo: `CARGO_TARGET_DIR=$HOME/.cache/packages/cargo-target` on every
  `cargo` and `cargo +1.88.0` invocation, in every worktree. Do not create a
  per-worktree `target/`.
- Playwright browsers stay in the existing browser cache. Do not download a
  second browser pack for a worktree.
- Skip `pnpm install` and Rust builds unless the task's checks need them.

### Swarm

Independent slices run together as a workflow. The standing entry point is
`.grok/workflows/task-swarm.rhai` (invoke it with the workflow tool, or write
a task-specific script when the slices are fixed). Each slice is one agent
with a self-contained prompt and a disjoint set of files. Agents write only
inside the task worktree. The parent integrates, reviews, and is the only
one who opens pull requests.

### Incremental commits and stacked pull requests

One logical slice per commit. A multi-slice task is a stack: the first pull
request targets `main`, and each next pull request targets the previous
branch.

Commits are created with GitHub's GraphQL `createCommitOnBranch` so the
committer is GitHub and the ruleset sees a verified signature. A local
`git commit`, including an SSH signature from `~/.ssh/opensesame_signing`,
is `unknown_key` and cannot merge. Omit an author override on the mutation.
`expectedHeadOid` is `origin/main` for the first commit and the previous
commit on the stack after that. The local git identity, when a tool needs
one, is Tyler Kendrick `<145080887+Tyler-R-Kendrick@users.noreply.github.com>`.

### After each commit

Run `df -h /`. Delete scratch under `/tmp` that this commit created, and any
build output that exists only because of that commit. Leave
`/tmp/os-wallet-ship`, the Host listening on `127.0.0.1:8787`, unrelated
worktrees, and the primary checkout's uncommitted work in place. Remove a
task worktree only after its branch has been squash-merged and its remote
branch deleted (`git worktree remove`, then `git worktree prune`).

### Done

When every pull request in the stack is open:

1. Self-review the diff and post that review on each pull request. Resolve
   every review thread opened on the stack.
2. A Copilot review request on this repository returns HTTP 422. CodeRabbit
   does not auto-review while the repository has fewer than 10 stars. The
   self-review is the review that has to land.
3. Squash-merge only after the required checks are green and the pull request
   is up to date with `main`: TypeScript, Rust, and Bundle budgets. The
   ruleset is squash-only. Do not pass `--admin`.
4. Merge from the bottom of the stack. After each squash, restack the next
   branch onto the new `main` with another verified `createCommitOnBranch`
   (full file contents of that slice, `expectedHeadOid` the new main tip)
   and squash-merge it the same way.
5. Remove the finished worktree and delete the local and remote branches.

User-visible product changes still follow §5 visual evidence and §8 gates.
This section is how the work is hosted. It does not waive those gates.

### Local task queue

`ops/routines/*.md` and `docs/contributing/agent-routines.md` are the local
task queue. Each routine starts with this same worktree, shared-cache, swarm,
stack, disk-check, and squash-merge sequence. A routine that edits the tree
does that work in `/home/codex/repos/opensesame-<routine>`, with independent
findings fanned out through `.grok/workflows/task-swarm.rhai`.
