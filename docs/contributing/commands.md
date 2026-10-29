# Command reference

Full command crib sheet moved from `AGENTS.md` §3. The canonical source of truth is the root `package.json` (and `apps/pages/package.json` for Pages `verify:*` gates); this page records the trigger and behaviour contracts for the curated gates. Everyday shortcuts are also in the repository `README.md` and `docs/getting-started/README.md`.

## 3. Command crib sheet

All scripts below are defined in the root `package.json` unless noted.

```bash
pnpm bootstrap           # install if needed + db:migrate + setup:hooks
                          # schema generation is deliberate: pnpm db:generate
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
pnpm test:anti-slop      # plugin RuleTester suite + installer-asset parity + MANIFEST.sha256 freshness
pnpm anti-slop:manifest  # rewrite the installer asset's MANIFEST.sha256 after changing a rule (ADR 0200)
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
pnpm test:proxied-run    # scripts/test/proxied-run-test.sh — `opensesame dev run --agent` end to end (ADR 0150): the
                          #   real binary, the surrogate-proxy plugin's TEST build installed through `plugins install`
                          #   with its pin, a token sealed by `pass insert connections/<org>/<name>`, the real
                          #   @env-spec/parser, a child that reaches a loopback stand-in for api.vercel.com only through
                          #   the run's proxy; pins the refusals, the revocation and how a run ends when `opensesame` is signalled. Needs node_modules for the parser
                          #   or OPENSESAME_E2E_ENVSPEC_DIR; fails, never skips (docs/operators/proxied-run-quickstart.md)
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
pnpm audit:browser-dispositions # re-probes every recorded request in spec/connectors/browser-dispositions.json from the
                            #   audited origin (unauthenticated, network); exits 1 when a provider's answer moved (ADR 0197)
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
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
  pnpm --filter @opensesame/pages verify:static
# Drives dist/ under https://tyler-r-kendrick.github.io/OpenSesame/ in
# headless Chromium: first screen is the front door's three roads + the guest
# Skip (no setup wall, no sign-in), guest walks every section, Google via a
# mocked shoo.dev lands unlocked once setup is skipped, deep links resolve. Fails on any page error, console error, loopback request,
# missing asset, or on-screen "No Identity API" copy.
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
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
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
  pnpm --filter @opensesame/pages verify:auth
# Same harness, the authentication flow (ADR 0091): a guest presses Add on the
# authenticator row and is walked through a key first (the PIN card, in the
# same sheet), then scan, then a code computed from the setup key on screen,
# then the recovery codes; lock → only the PIN tab, code announced as step 2 →
# PIN → code → open, again after a reload; and a password-sealed vault the
# same way. Run before touching unlock methods, second steps or the unlock
# screen.
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
  pnpm --filter @opensesame/pages verify:device-identity
# Same harness, the device as the Identity plane (ADR 0160), a guest with no
# Identity API at desktop and phone widths: no sign-out row until the device
# has a session, the status reads "This device", the session's principal is
# the vault key's thumbprint and survives Refresh, every Settings section and
# Access tab reads clean, and Receipts is drawn only once Browser-local IAM
# serves an audit trail. Run before touching `identityPlane`, `identityServes`,
# the device host, or a panel gated on the Identity plane.
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
  pnpm --filter @opensesame/pages verify:device-inbox
# Same harness, the device's receipts, inbox and local notifications (ADR 0162)
# in a vault with no Identity API and no Host, at desktop and phone widths: a
# request raised and shown on the tab, told to a second tab (title, bell, one
# system notification carrying only { kind, action, ref }), approved and refused
# with the keyboard and the passkey, every decision a receipt in Sessions, an
# application signed in and revoked, and a locked vault showing nothing and
# answering 423. Own CI job, required through Bundle budgets. Run before
# touching `device-receipts`, `device-inbox`, `local-notifications` or Receipts.
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
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
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
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
# Same harness, live sessions (ADR 0150, ADR 0193) in real browser contexts over
# real WebRTC, every walk once per joiner browser: the owner in LIVE_OWNER, the
# joiners in LIVE_JOINERS (chromium, firefox, webkit as the pinned Playwright
# installs them: `pnpm exec playwright install --with-deps chromium firefox
# webkit`; PLAYWRIGHT_CHROMIUM may point Chromium elsewhere). A walk an engine
# cannot take here prints NOT TAKEN with why (lib/live-engines.mjs). CI runs it
# as "Live join (<owner> owner)", three shards with every joiner each, folded
# into the required weekly prerelease gate. Needs a second build first: `pnpm --filter @opensesame/pages
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
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
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
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
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
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
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
