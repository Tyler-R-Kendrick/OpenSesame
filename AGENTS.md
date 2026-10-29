# AGENTS.md

Agent context for OpenSesame. This file is the canonical entry point for any coding agent working in this repo — read it before spelunking. It is a thin product contract: identity, boundaries, invariants, canonical commands, and routing. Detail lives in the linked reference pages, not here.

## How a task starts

Start every goal in an isolated worktree branched from `origin/main`, fan independent slices out separately, and ship them as stacked pull requests that squash-merge into `origin/main` once the required checks are green. Summary in §9; full procedure in [shipping](docs/contributing/shipping.md).

## 1. What this is

OpenSesame is a private **authorization fabric for the agentic era**: a dual-plane system with a **host/client** product topology (see [ADR 0017](docs/adr/0017-host-client-product-topology.md)).

- **Host / authority plane (Rust)** — one native binary, `opensesame` (`apps/cli`), whose roles are subcommands ([ADR 0138](docs/adr/0138-self-issued-identity-one-native-host.md)): `opensesame host run` serves the Host API (`crates/gateway`, `:8787`: ConnectionRef → authorize → invoke → receipt), `opensesame daemon run` the local host agent (`crates/daemon`, `:18790`), `opensesame worker run` the workload connector host (`crates/worker`). Password-manager ecosystem bridging is human/device/ops plane only, never agent-facing ([ADR 0052](docs/adr/0052-password-manager-ecosystem-bridging.md), [ADR 0053](docs/adr/0053-pm-bridge-binaries.md)).
- **Client plane (Rust → Wasm + TS)** — `client-core` E2EE sync + `packages/api-client` (Host API TS client). Browser extension `apps/browser-extension`, offline GitHub Pages PWA `apps/pages`, Client CLI `packages/cli` (binary `opensesame-id`), MCP servers `packages/mcp-client` / `packages/mcp-host`.
- **Identity plane (TypeScript)** — Identity API `packages/control-plane` (`:8788`, Hono + Better Auth + oidc-provider), mock upstream IdP `tools/mock-upstream-idp` (`:9090`).

Identity and Host APIs are kept **deliberately separate** — no BFF merge. Canonical principals live in OpenSesame domain models (`packages/os-domain`), not Better Auth user IDs. System picture: [architecture](docs/architecture/README.md).

## 2. Toolchain

Pins are canonical in `package.json` (`engines`, `packageManager`, devDependencies) and `rust-toolchain.toml` — read them there, do not copy versions into new prose. In short: Node ≥ 22, pnpm via Corepack, Rust pinned by `rust-toolchain.toml` (`cargo +1.88.0 ...`), Turbo for workspace tasks, Biome for lint/format, Oxlint anti-slop, Vitest and Playwright for tests. Setup detail: [getting started](docs/getting-started/README.md).

## Cursor Cloud specific instructions

Generic cloud-agent environment notes live in [cloud agents](docs/contributing/cloud-agents.md). Harness-specific model or subscription routing is not repository policy and is not recorded here. Never run `sudo` in agent commands; never commit secrets.

## 3. Command crib sheet

All scripts are defined in the root `package.json` unless noted. Full reference (per-plane run commands and every Pages `verify:*` trigger and behaviour contract): [commands](docs/contributing/commands.md). Script catalogue: [scripts](scripts/README.md).

```bash
pnpm bootstrap     # install if needed + db:migrate + setup:hooks
pnpm dev           # turbo dev (Identity plane and related packages)
pnpm build         # turbo build
pnpm lint          # Biome on changed files + repository/evidence checks
pnpm quality       # structure, coupling, design and docs-index gates
pnpm typecheck     # strict TypeScript across the workspace
pnpm test          # turbo test
pnpm verify        # full local gate: lint, anti-slop, quality, tests
pnpm docs:index    # regenerate ADR/audit/evidence indexes after docs changes
```

Before pushing: `pnpm lint && pnpm quality && pnpm typecheck && pnpm test` (see §8). Schema generation is deliberate — see [getting started](docs/getting-started/README.md), not a root shortcut.

## 4. Layout map

Top level: `apps/` (runnable surfaces), `crates/` (Rust host/authority and client core), `packages/` (TypeScript libraries and planes), `examples/`, `marketplace/`, `spec/`, `tests/`, `tools/`, `scripts/`, `ops/`, `skills/`, `patches/`, `docs/`. **Do not add new top-level directories.** Detailed path-by-path map: [layout map](docs/architecture/layout-map.md); narrative tour: [repository tour](docs/getting-started/repository-tour.md); per-area summaries in `crates/README.md`, `packages/README.md`, `apps/README.md`.

Repository footprint: persist source and approved evidence only; scratch and task output stay in ignored `work/` or temp. Canonical rules: [repository footprint](docs/contributing/repository-footprint.md).

### Subsystem routing

| Touching | Start at |
|---|---|
| Host API, grants, invocation | `crates/gateway`, [host/client topology](docs/architecture/host-client-topology.md) |
| Identity, OIDC, principals | `packages/control-plane`, `packages/os-domain`, [identity plane](docs/architecture/identity-plane.md) |
| Pages PWA, vault UI | `apps/pages`, `packages/app-core`, [commands](docs/contributing/commands.md) for `verify:*` |
| Vault format, keys | [vault format v1](docs/architecture/vault-format-v1.md), [key hierarchy](docs/security/key-hierarchy.md) |
| Connections, authority | [connection broker](docs/architecture/connection-broker.md), [general authority](docs/architecture/general-authority.md) |
| Transport, mTLS | [transport topology](docs/architecture/transport-topology.md) |
| Design rules, merge gates | §5 below, [design rules — full text](docs/contributing/design-rules.md) |
| Security posture, audits | §6 below, [security](docs/security/README.md) |
| CI, verification | §8 below, [contributing](docs/contributing/README.md), [verification detail](docs/contributing/verification.md) |
| Decisions | [ADRs](docs/adr/README.md) — record consequential decisions there |

## 5. Design rules that gate merges

One-line invariants below; full prose, rationale, and exact gate triggers in [design rules — full text](docs/contributing/design-rules.md). Where a rule and its cited ADR disagree, the ADR governs.

- A user-visible change ships with before/after evidence on the PR, from two real builds with browser measurements; persist only approved current-state artifacts under `docs/evidence/<feature>/<project>/<platform>/` ([evidence contract](docs/evidence/README.md)).
- Local app runs are attached HMR debug sessions; do not replace them with a production `dist/` or headless gate unless that gate was requested.
- Keyboard access is a core product contract: every arrival leaves visible, useful focus; shell/control/focus changes require `pnpm --filter @opensesame/pages verify:keyboard`.
- A phone is not a narrow desktop: touch geometry is measured, not screenshotted; shell/chrome/coarse-pointer changes require `verify:mobile`. Never pass by clipping a control or lowering a floor.
- Browser-local IAM must prove an actual sign-in (`verify:local-iam`); a form or mocked success is not authentication evidence.
- Web Push is proved against a real Identity API (`verify:push-worker` and `verify:push`), never only against a mocked enrolment.
- `@opensesame/os-domain` must not import Better Auth, oidc-provider, Hono, Drizzle, or React. Prefer mature libraries over NIH protocol code ([ADR 0008](docs/adr/0008-better-auth-oidc-provider.md)). No Clerk or Marketplace auth as core ([ADR 0004](docs/adr/0004-no-vercel-marketplace-for-core.md)).
- The static front end is complete without a backend ([ADR 0090](docs/adr/0090-static-frontend-complete-without-backend.md)): nothing may be placed in front of the Pages first screen. Never remove or hide the guest/anonymous access flow.
- Nothing the client stores rests in the clear ([ADR 0149](docs/adr/0149-nothing-stored-in-the-clear.md)); a database holding identifiers hides its shape too ([ADR 0175](docs/adr/0175-searchable-encryption-over-indexeddb.md)).
- Logs and events carry no secrets and rest sealed ([ADR 0157](docs/adr/0157-logs-and-events-carry-no-secrets.md)).
- An authorization check is a proof the compiler can see ([ADR 0178](docs/adr/0178-authorization-checks-are-proofs-the-compiler-can-see.md)). A credential is never handed to a caller without an explicit export grant; possessing a ConnectionRef never implies permission to resolve it ([ADR 0005](docs/adr/0005-authority-handle-connectionref.md)).
- A new vault is sealed with a passkey, never a master password ([ADR 0180](docs/adr/0180-vaults-are-sealed-by-passkey-not-password.md)). Vault keys never leave memory; only ciphertext is persisted.
- Security facts share one path (`SecurityNotice`, [ADR 0080](docs/adr/0080-security-event-hooks.md)); lifecycle/expiry hooks follow [ADR 0074](docs/adr/0074-expiry-lifecycle-hooks.md); breach checks disclose nothing about a tenant; certificate custody follows [ADR 0075](docs/adr/0075-host-certificate-key-custody.md).
- mTLS is optional, per hop, and never a fallback ([ADR 0132](docs/adr/0132-optional-mtls-and-workload-identity.md)). Every hop is declared; no profile substitutes for another.
- A sensitive approval is bound to its transaction digest; notification channel and approval strength are separate concerns ([ADR 0084](docs/adr/0084-external-authorization-notifications.md), [ADR 0086](docs/adr/0086-wallet-native-interaction-layer.md)).
- Settings rows act or are not drawn ([ADR 0158](docs/adr/0158-settings-rows-act-or-are-absent.md)); Settings is files ([ADR 0134](docs/adr/0134-item-type-marketplaces-and-settings-files.md)); keybindings are a person's own ([ADR 0156](docs/adr/0156-keybindings-and-macros.md)).
- Built-in item types beyond the core are packs ([ADR 0165](docs/adr/0165-item-type-packs-on-demand.md)); a vault item type is a manifest, never a code path ([ADR 0087](docs/adr/0087-vault-item-type-plugins.md)); one definition, every target ([ADR 0139](docs/adr/0139-one-definition-every-target.md)).
- A password is produced by one facade; a pepper is never asked for ([ADR 0174](docs/adr/0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)). A surrogate selects a credential; it never becomes one ([ADR 0150](docs/adr/0150-surrogate-credentials-at-the-last-hop.md)). A connector arrives by reference, never by credential ([ADR 0115](docs/adr/0115-front-door-and-connector-directory.md)).
- Every new user-facing capability reaches parity across surfaces ([ADR 0065](docs/adr/0065-agent-surface-parity.md)) and is an optional, consented capability until load ([ADR 0130](docs/adr/0130-operator-controlled-capability-composition.md), [ADR 0189](docs/adr/0189-settings-features-and-integrations.md)). Every feature has a replayable, walked tutorial ([ADR 0163](docs/adr/0163-tutorial-mode.md)). In-product support points, never acts ([ADR 0088](docs/adr/0088-ai-native-contextual-support.md)). Payment authorization is in scope; payment credentials never are.
- A source file stays under 400 lines and the debt ledger only falls ([ADR 0093](docs/adr/0093-structural-quality-gates.md)); never raise a recorded ratchet number to get a change through.
- Pages/PWA/ceremony UI follows [DESIGN.md](DESIGN.md) and [controls](docs/design/controls.md); `pnpm lint:design` enforces it.
- No `sudo`. Configuration follows the `.env.schema` env-spec pattern. Never commit or log live secrets, tokens, or credential material.
- Record consequential decisions as ADRs under `docs/adr/`, numbered in order, then run `pnpm docs:index`.

## 6. Security posture

Canonical reading: [threat model](docs/security/threat-model.md), [security boundaries](docs/security/security-boundaries.md), [key hierarchy](docs/security/key-hierarchy.md), audits under `docs/security/audits/` (index regenerated by `pnpm docs:index`), and the `pnpm audit:*` gates catalogued in [scripts](scripts/README.md) with rationale in [tooling evaluation](docs/security/tooling-evaluation.md). Detail moved from this section: [security posture — detail](docs/contributing/security-posture.md).

External/model-based security checkers supplement, never replace, `pnpm audit:*`. Never run one as a bare uncapped whole-repo scan; get explicit approval before any model/repository-content egress; keep scanner artifacts private and validate every candidate against the source-to-sink path before changing code.

## 7. Skills

Skills are canonical in `skills/*/SKILL.md`, mirrored through `.agents/skills/`; tiers are defined in `skills/profiles.json` (core first-party required, optional profiles may be absent). Third-party skills are gitignored install output installed/refreshed to latest (unpinned) by `scripts/dev/install-agent-skills.sh` (`pnpm skills:install`, devcontainer post-start) per the `skills-lock.json` catalogue — never stage installed trees. Sync with `scripts/dev/sync-agent-skills.mjs` (and its `--check`), never by multi-target copy. Routing index: [skills](docs/contributing/skills.md). Personal user-scope setup: [agent setup](docs/contributing/agent-setup.md).

## 8. Verification expectations

Before pushing:

```bash
pnpm setup:hooks
# Commit: staged lint. Push: static quality + lint + typecheck; tests qualify CD.
```

Run focused local tests for behavior you change.

Full local gate: `pnpm verify`. A user-visible change carries before/after evidence on the PR (§5). Auth, crypto, authorization, and transport changes also run the relevant `pnpm audit:*` gates and the browser gates their diff reaches ([commands](docs/contributing/commands.md)). Trunk CI only builds the affected graph (required checks: **TypeScript**, **Rust**, **Bundle budgets** — the last is a compatibility reporter, not a budget gate); tests and broad matrices qualify delivery in the nightly/weekly promotion pipeline — contract in [CI and artifact promotion](docs/operators/ci-promotion.md) and [ADR 0215](docs/adr/0215-trunk-builds-only.md), detail in [verification and CI](docs/contributing/verification.md). Verify through the real interface the change affects; a passing unit test is not evidence a person can use a screen, and a claim without an observed run is unverified.

## 9. Starting, parallelizing, and shipping a task

Generic sequence: fetch `origin/main` → isolated worktree → one coherent slice per commit/PR → stacked PRs for dependent slices → required checks green, review threads resolved, up to date with `main` → squash-merge. Commits are signed and verified under the repository's governance in `ops/github/`; use your own configured identity and signing key. Full procedure (worktrees, shared caches, stacked PRs, done criteria, task queue): [shipping](docs/contributing/shipping.md) and [agent routines](docs/contributing/agent-routines.md).
