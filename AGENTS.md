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
pnpm lint:all            # full-repository Biome + anti-slop audit
pnpm lint:anti-slop      # strict Oxlint anti-slop; nested configs/unused disables fail
pnpm test:anti-slop      # plugin RuleTester suite + installer-asset parity
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
pnpm verify              # changed-file lint + anti-slop lint/plugin tests + test:all
                          #   + cargo +1.88.0 test --workspace --all-targets
                          #   + ./scripts/battle-test.sh — full local gate

# Security/audit gates (each backed by scripts/*-gate.sh)
pnpm audit:cve-lite
pnpm audit:ast-grep
pnpm audit:clippy
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
./target/debug/opensesame pass seal manifest.json --shred  # encrypt a Pages manifest
./target/debug/opensesame pass backup                      # commit + push to origin
# backup auth for GitHub HTTPS remotes: GITHUB_TOKEN → GitHub App
# (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH) → `gh auth token`
```

**Pages (offline PWA) dev server:**
```bash
pnpm --filter @opensesame/pages dev   # vite --port 5180 --strictPort
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
| `crates/human-vault` | E2EE envelope crypto shared by vault + sealed-store |
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
| `apps/mcp-client` / `apps/mcp-host` | MCP servers (client- and host-facing) |
| `apps/console` | Vite Identity console (web UI) |
| `apps/worker` | Background worker |
| `apps/browser-extension` | WXT browser extension |
| `apps/example-rp-alpha` / `apps/example-rp-beta` | Example relying-party apps |
| `apps/example-agent` / `apps/example-headless` | Example agent / headless client |
| `packages/os-domain` | Domain models — must not import Better Auth/oidc-provider/Hono/Drizzle/React |
| `packages/database` | Drizzle schema + migrations |
| `packages/api-client` | Host API TS client |
| `packages/cli` | Client CLI, binary `opensesame-id` |
| `packages/auth-upstream` / `oauth-provider` / `claims` / `device-auth` | Identity-plane building blocks |
| `packages/policy` / `audit` / `contracts` | Authorization policy, audit trail, shared contracts |
| `packages/sdk-browser` / `sdk-server` / `sdk-cli` | Client SDKs |
| `packages/agent-protocols` | Agent-facing protocol adapters |
| `packages/testing` | Shared test utilities (incl. `test:security`) |
| `packages/identity-atproto` / `identity-nostr` | Alternate-identity linking |
| `packages/observability` | Structured logging + deep redaction |
| `packages/config` | Shared tsconfig |
| `packages/env-spec-bridge` | env-spec ↔ runtime config bridge |
| `skills/` | Agent skills — see §7 |
| `wit/` | Polyglot core contracts (client, connector, core, host, mediation, proof, task) |
| `docs/` | Architecture, ADRs, security, operators, validation, implementation docs; competitor references under `docs/competitors/` |

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
  0001–0053).
- Never expose raw secrets, private proof keys, or a public `getSecret()`
  affordance. Agent-facing APIs use ConnectionRef + Intent
  ([ADR 0005](docs/adr/0005-authority-handle-connectionref.md)).
- No `sudo` (`.cursor/rules/no-sudo.mdc`).
- Configuration follows the `.env.schema` env-spec pattern (`@type`,
  `@required`, `@sensitive`, `@public` annotations). Never commit live
  secrets; dev signing keys and claim peppers are generated outside git.

## 6. Security posture

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
deterministic `pnpm audit:*` gates; it does not replace them. CLI `0.1.16` with
bundled plugin `0.1.22` was the latest release validated in this repository on
2026-08-21.

Before a scan, check the installed and published versions. Upgrade only when
the task authorizes changing user-level tooling, and install an exact version:

```bash
codex-security --version
npm view @openai/codex-security version dist-tags --json
npm install -g @openai/codex-security@<exact-version>
codex-security --version
```

Routine reviews must target a committed diff or explicit paths. Never start a
bare, uncapped repository-wide scan. Set the budget before permitting network
access, run preflight first, and retain artifacts outside the checkout:

```bash
codex-security scan <clean-checkout> \
  --diff <base-sha-or-ref> --head HEAD \
  --max-cost 15 \
  --fail-on-severity high \
  --headless --verbose \
  --output-dir <trusted-state-dir> --archive-existing \
  --dry-run

# Remove --dry-run only after checking target, base/head, model, effort,
# authentication method, output directory, and maxCostUsd in preflight output.
```

The `$15` cap is the default ceiling, not a promise that the scan will finish.
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
  --diff <base-sha> --head HEAD --max-cost 15 --fail-on-severity high \
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
holds symlinks to the same directories for tools that look there instead.

| Skill | Path | Purpose |
|-------|------|---------|
| `opensesame-apis` | `skills/opensesame-apis/SKILL.md` | Install, configure, initialize, and use OpenSesame Host and Identity APIs |
| `opensesame-chrome-extension` | `skills/opensesame-chrome-extension/SKILL.md` | Install, configure, initialize, and use the OpenSesame browser extension |
| `opensesame-clis` | `skills/opensesame-clis/SKILL.md` | Install, configure, initialize, and use OpenSesame host and client CLIs |
| `opensesame-mcps` | `skills/opensesame-mcps/SKILL.md` | Install, configure, initialize, and use OpenSesame MCP servers |
| `install-anti-slop` | `skills/install-anti-slop/SKILL.md` | Install and configure the vendored Oxlint anti-slop plugin |

## 8. Verification expectations

Before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

For the full local gate suite (what `pnpm verify` runs — required before
anything security-sensitive lands):

```bash
pnpm verify   # changed-file lint + test:all (typecheck + test + integration)
              #   + cargo +1.88.0 test --workspace --all-targets
              #   + ./scripts/battle-test.sh
```

This repo intentionally has **no GitHub Actions / CI** — there is no
`.github/` directory, and it should stay that way. Verification is local:
git hooks plus the commands above, supplemented by scheduled Claude Code
sessions documented in `docs/operations/agent-routines.md`. Run the
relevant `pnpm audit:*` gates (§3/§6) for changes touching auth, crypto, or
dependency surfaces.
