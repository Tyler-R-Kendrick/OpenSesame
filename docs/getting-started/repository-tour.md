# Repository tour

OpenSesame is one repository holding two build systems: a **pnpm** workspace
for TypeScript and a **Cargo** workspace for Rust. Both are rooted at the top
level, and the directory a project lives in says what kind of thing it is.

## Top-level directories

```text
apps/          deployable products and services (Rust binaries and TypeScript apps)
crates/        Rust libraries                          → Cargo workspace members
packages/      TypeScript libraries (@opensesame/*)    → pnpm workspace members
examples/      runnable integrations built only on public SDKs
marketplace/   vault item-type definitions (built-in + installable)
spec/          language-neutral contracts both planes compile against
tests/         cross-cutting test suites and shared fixtures
tools/         development tooling: lint plugins, quality baselines, dev servers
scripts/       the scripts behind `pnpm <task>`: quality/, audit/, fuzz/, test/, mtls/, release/, dev/
ops/           deployment references, repo governance, scheduled routines
skills/        agent skills (also exposed through .agents/skills)
docs/          documentation
```

Dot-directories hold tool configuration that tools look up by name:
`.github/` (CI), `.githooks/` (local hooks), `.devcontainer/`, `.cargo/`,
`.opensesame/` (this repository's item-type marketplace index), and the
agent/editor directories `.agents/`, `.claude/`, `.codex/`, `.cursor/`,
`.impeccable/`, `.deepsec/`.

## The three planes in the tree

| Plane | Language | Runs | Lives in |
|---|---|---|---|
| **Host / authority** — authorize, invoke, receipt | Rust | Host API `crates/gateway`, daemon `crates/daemon`, host CLI `apps/cli`, helpers `crates/credential-helpers`, bridges `crates/pm-bridges` | `crates/*` (54 libraries), facade `crates/host-core` |
| **Identity** — who someone is | TypeScript | Identity API `apps/control-plane`, console `apps/console`, ceremonies `apps/ceremonies` | `packages/os-domain`, `oauth-provider`, `auth-upstream`, `claims`, `database`, `policy` |
| **Client** — a person's device | TypeScript (+ Rust→Wasm) | Pages PWA `apps/pages`, extension `apps/browser-extension`, client CLI `packages/cli`, MCP servers `packages/mcp-*` (served by `opensesame-id mcp`) | `packages/app-core`, `packages/vault-core`, `packages/api-client`, `crates/client-core` |

The contracts all three share live in [`spec/`](../../spec/README.md) (WIT
worlds, the Host OpenAPI, the OpenFGA model) and in `packages/os-domain` /
`crates/domain` (the domain model, mirrored in each language).

## Where does … live?

| Looking for | Go to |
|---|---|
| A Host API route | `crates/gateway/src/routes/` |
| An Identity API route | `apps/control-plane/src/routes/` |
| A screen in the app | `apps/pages/src/screens/` and `apps/pages/src/sections/` (React); its logic in `packages/app-core/src/screens/` / `sections/` (`*-model.ts`) |
| Vault encryption and the file format | `packages/vault-core` (browser), `crates/human-vault` (Host) |
| The sealed `pass`-compatible store | `crates/sealed-store`, verbs in `apps/cli` |
| Host database schema | `crates/storage/migrations/*.sql`, one module per concern in `crates/storage/src/` |
| Identity database schema | `packages/database/src/schema/`, migrations in `packages/database/drizzle/` |
| A vault item type | [`marketplace/item-types/`](../../marketplace/README.md) |
| A connector definition | `spec/connectors/catalog.json`, `spec/connectors/` |
| Authorization policy | `crates/authz`, `packages/policy`, model in `spec/openfga/model.fga` |
| A capability (optional feature) | `packages/app-core/src/lib/capabilities/`, module in `apps/pages/src/modules/<id>/` |
| MCP / WebMCP tools | `packages/mcp-host`, `packages/mcp-client`, `packages/webmcp`; parity in `packages/capability-registry` |
| A `pnpm` command's implementation | `package.json` → `scripts/<purpose>/` ([index](../../scripts/README.md)) |
| A CI job | `.github/workflows/ci.yml` |

## Rules that follow from the layout

These are enforced by gates, not by convention; the full list is in
[`AGENTS.md` §5](../../AGENTS.md#5-design-rules-that-gate-merges).

- **`packages/os-domain` imports no framework** — no Better Auth,
  oidc-provider, Hono, Drizzle or React.
- **`packages/app-core` and `packages/vault-core` reach into no app** and read
  no platform global outside their `browser/`, `node/` or `sandbox/` host
  adapters (`pnpm quality:app-core`).
- **No dependency cycles, no undeclared workspace imports** between packages or
  crates (`pnpm quality:packages`).
- **A source file stays under 400 lines**, and complexity is ratcheted against
  [`tools/quality/quality-baseline.json`](../../tools/quality/quality-baseline.json)
  — it may only fall (`pnpm quality:gate`).
- **Optional features never load before consent**: the Pages bootstrap may not
  statically import a capability module (`verify:capability-graph`).
- **Identity and Host stay separate** — no route of one is proxied through the
  other.

## Adding things

| To add | Do this |
|---|---|
| A TypeScript library | `packages/<name>/` with `package.json` named `@opensesame/<name>`, `tsconfig.json` extending `../../tsconfig.base.json`, and `typecheck` + `test` scripts. |
| A Rust library | `crates/<name>/` with package name `opensesame-<name>`, `version.workspace = true`, and an entry in the root `Cargo.toml` `members`. |
| A deployable app | `apps/<name>/`. TypeScript apps are picked up by `apps/*` in `pnpm-workspace.yaml`; Rust apps need a `Cargo.toml` `members` entry. |
| An example | `examples/<name>/` with a `README.md` and a package named `@opensesame/example-<name>`. It may depend only on published SDK packages. |
| A test suite spanning packages | `tests/<name>/`, plus a line in `pnpm-workspace.yaml` if it is a TypeScript package. |
| A vault item type | A JSON file in `marketplace/item-types/` — see [the marketplace guide](../../marketplace/README.md). |
| A user-facing capability | A `packages/capability-registry` entry mapping it onto every agent surface ([ADR 0065](../adr/0065-agent-surface-parity.md)), and for optional features the five pieces in [ADR 0130](../adr/0130-operator-controlled-capability-composition.md). |
| A decision | An ADR in `docs/adr/`, then `pnpm docs:index`. |
