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
- Biome `1.9.4` (lint + format, 2-space indent) — config is `biome check .`
- Vitest `4.1.10` (TS unit/integration tests), Playwright `1.55.1` (e2e)

## 3. Command crib sheet

All scripts below are defined in the root `package.json` unless noted.

```bash
pnpm bootstrap           # install + db:generate + db:migrate
pnpm dev                 # turbo dev (control-plane, console, worker,
                          #   mock-upstream-idp, example-rp-alpha/beta), parallel
pnpm build               # turbo run build
pnpm typecheck           # turbo run typecheck
pnpm lint                # biome check .
pnpm lint:fix            # biome check --write .
pnpm test                # turbo test across packages/*, control-plane, worker
pnpm test:integration    # turbo run test:integration
pnpm test:e2e            # turbo run test:e2e
pnpm test:security       # @opensesame/testing test:security
pnpm test:task-access    # scripts/task-security-battle-test.sh
pnpm test:all            # typecheck + test + test:integration
pnpm db:migrate          # @opensesame/database db:migrate
pnpm db:reset            # @opensesame/database db:reset
pnpm generate:openapi    # writes apps/control-plane/openapi.json
pnpm generate:sbom       # CycloneDX SBOM to sbom/bom.json
pnpm verify              # test:all + cargo +1.88.0 test --workspace --lib
                          #   + ./scripts/battle-test.sh — full local gate

# Security/audit gates (each backed by scripts/*-gate.sh)
pnpm audit:cve-lite
pnpm audit:ast-grep
pnpm audit:clippy
pnpm audit:osv
pnpm audit:cargo-audit
pnpm audit:gitleaks
pnpm audit:semgrep
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
```

**Pages (offline PWA) dev server:**
```bash
pnpm --filter @opensesame/pages dev   # vite --port 5180 --strictPort
```

## 4. Layout map

| Path | Role |
|------|------|
| `crates/core`, `crates/host-core`, `crates/client-core` | WIT/Wasm polyglot core + product-SDK facades |
| `apps/gateway` | Host API, `:8787` (`opensesame-gateway`) |
| `apps/daemon` | Local host agent, `:18790` (`opensesame-daemon`) |
| `apps/cli` | Host CLI, binary `opensesame` (`opensesame-cli`) |
| `apps/toolbar` | Daemon control stub (`opensesame-toolbar`) |
| `apps/credential-agent` | Legacy credential agent (`opensesame-credential-agent`) |
| `apps/callback-edge` | Edge callback service (`opensesame-callback-edge`) |
| `apps/control-plane` | Identity API, `:8788` (Hono + Better Auth + oidc-provider) |
| `apps/mock-upstream-idp` | Deterministic mock OIDC upstream for local dev, `:9090` |
| `apps/pwa` / `apps/mobile-mfa` | Client PWA + step-up MFA UX (against `:8788`) |
| `apps/pages` | Installable GitHub Pages offline PWA — authority vault |
| `apps/mcp-client` / `apps/mcp-host` | MCP servers (client- and host-facing) |
| `apps/console` | Vite Identity console (web UI) |
| `apps/web-console` | Stub package reserved for a future Next.js console — use `apps/console` today |
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
| `packages/client-crypto` | Client-side crypto primitives (E2EE) |
| `skills/` | Agent skills — see §7 |
| `wit/` | Polyglot core contracts (client, connector, core, host, mediation, proof, task) |
| `docs/` | Architecture, ADRs, security, operators, validation, implementation docs |

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
  0001–0031).
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
  `scripts/semgrep-gate.sh`.

## 7. Skills

Agent skills live under `skills/*/SKILL.md` (canonical). `.agents/skills/`
holds symlinks to the same directories for tools that look there instead.

| Skill | Path | Purpose |
|-------|------|---------|
| `opensesame-apis` | `skills/opensesame-apis/SKILL.md` | Install, configure, initialize, and use OpenSesame Host and Identity APIs |
| `opensesame-chrome-extension` | `skills/opensesame-chrome-extension/SKILL.md` | Install, configure, initialize, and use the OpenSesame browser extension |
| `opensesame-clis` | `skills/opensesame-clis/SKILL.md` | Install, configure, initialize, and use OpenSesame host and client CLIs |
| `opensesame-mcps` | `skills/opensesame-mcps/SKILL.md` | Install, configure, initialize, and use OpenSesame MCP servers |

## 8. Verification expectations

Before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

For the full local gate suite (what `pnpm verify` runs — required before
anything security-sensitive lands):

```bash
pnpm verify   # test:all (typecheck + test + test:integration)
              #   + cargo +1.88.0 test --workspace --lib
              #   + ./scripts/battle-test.sh
```

This repo intentionally has **no GitHub Actions / CI** — there is no
`.github/` directory, and it should stay that way. Verification is local:
git hooks plus the commands above, supplemented by scheduled Claude Code
sessions documented in `docs/operations/agent-routines.md`. Run the
relevant `pnpm audit:*` gates (§3/§6) for changes touching auth, crypto, or
dependency surfaces.
