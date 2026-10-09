# Contributing

How a change gets from a branch to `main`, what checks it on the way, and why
each check exists. The short version is [CONTRIBUTING.md](../../CONTRIBUTING.md);
the rules themselves are [`AGENTS.md`](../../AGENTS.md).

## The path of a change

1. **Branch and build.** `pnpm install`, `pnpm setup:hooks`, then work
   against the package you are changing
   (`pnpm --filter @opensesame/<name> test`).
2. **Commit.** The pre-commit hook lints staged files, runs Clippy when Rust
   is staged, scans for secrets and checks the design contract.
3. **Push.** The pre-push hook runs the anti-slop lint and plugin tests, then
   `pnpm typecheck && pnpm test`, by default
   (`OPENSESAME_PREPUSH=off|fast|full`).
4. **Open a pull request.** CI reports three required checks. A user-visible
   change carries before/after evidence
   ([visual-evidence skill](../../skills/visual-evidence/SKILL.md)).
5. **Merge.** Squash only, signed commits, up to date with `main`, review
   threads resolved. `main` then deploys the Pages app and verifies the live
   site serves that exact build.

## CI

`.github/workflows/ci.yml` runs on every pull request. The required check
names are still TypeScript, Bundle budgets, and Rust, and each one reports
on every pull request. The suite behind a check runs only when
[`scripts/lib/ci-changed-areas.mjs`](../../scripts/lib/ci-changed-areas.mjs)
says the diff can affect it. A docs-only change runs the signature check
and passes the three required checks without those suites. A path the
classifier does not recognize runs every suite.

A pull request runs what its diff can reach
([ADR 0176](../adr/0176-ci-runs-what-a-diff-can-reach.md)): the browser gates
[`scripts/lib/ci-gates.mjs`](../../scripts/lib/ci-gates.mjs) maps the changed
files to (the bundle job's matrix is written from
[`ci-bundle-shards.json`](../../scripts/lib/ci-bundle-shards.json)), and the unit
tests [`scripts/lib/ci-scoped-tests.mjs`](../../scripts/lib/ci-scoped-tests.mjs)
selects. A push to `main` and a manual run have no diff and run everything, so
a scoping rule that dropped a check fails there.

| Check | Suite, when the diff touches that area |
|---|---|
| **TypeScript** | Commit-signature check (every pull request), then frozen install, changed-file lint, and `pnpm quality`. `pnpm typecheck` runs for the workspace packages the diff changes and the packages that depend on them ([`scripts/lib/ci-affected-tests.mjs`](../../scripts/lib/ci-affected-tests.mjs)); their tests run for what the diff reaches (`vitest related`, plus every test that reads the filesystem), or whole when a manifest, config or test setup changed. A root manifest, lockfile, or `turbo.json` still tests every package. Product-experience contracts run when that set includes one of their packages. A workflow or script change runs lint and quality and skips package tests. |
| **Rust** | `cargo test --all-targets -p` for the crates the diff changes and the crates that depend on them. The whole workspace runs when a root Cargo file, the lockfile, the toolchain, or `spec/` changes. Skipped when no Rust, Cargo, or embedded host input changed. |
| **Bundle budgets** | Builds `apps/pages`, checks [`tools/quality/bundle-budgets.json`](../../tools/quality/bundle-budgets.json), and runs the Pages browser gates in Chromium (WebMCP, keyboard, mobile, local IAM, SIOPv2, and the rest) that the diff can reach, one matrix shard each. Skipped when the diff reaches none. |

mTLS is not a required check. It runs when the diff touches the transport
crates, the gateway, ingress or NATS config, or the Pages transport scripts.
The Android and Apple native builds are jobs of their own that the Rust check
waits on, so a failure there fails Rust. They run when the diff touches
`apps/android`, `crates/authenticator-core`, the root Cargo files, the
toolchain, `ci.yml` or a `scripts/test/mobile-*.sh` script
([`scripts/test/mobile-changed.sh`](../../scripts/test/mobile-changed.sh)).

`.github/workflows/deploy-pages.yml` publishes `apps/pages` on every push to
`main`. Two more workflows are not required checks:
`.github/workflows/full-suite.yml` runs the whole TypeScript workspace on `main`
every night and on demand, and `.github/workflows/password-parity.yml` runs the
2password parity gauntlet on pull requests that touch the CLI, Pages, the
extension, the crates or the packages it exercises. Branch protection is kept as
code in [`ops/github`](../../ops/github).

CI is the merge gate, not the whole story. Heavier checks run locally
(`pnpm verify`, the `pnpm audit:*` gates) and on a schedule through
[agent routines](agent-routines.md).

## The gates, and why each exists

| Gate | Command | Enforces | Why |
|---|---|---|---|
| Lint | `pnpm lint` | Biome formatting and lint on changed files. | One style, no review time spent on it. |
| Anti-slop | `pnpm lint:anti-slop` | No unsafe casts, no `unknown` leaking through APIs, no module mocking. | Type holes are where security bugs hide. |
| Structure | `pnpm quality:gate` | Files ≤ 400 lines; function length, parameters and nesting within budget; the ledger only falls. | [ADR 0093](../adr/0093-structural-quality-gates.md); [guide](../validation/code-quality-gates.md). |
| Coupling | `pnpm quality:packages` | No dependency cycles, no undeclared workspace imports, coupling debt only falls. | Packages that can be understood alone. |
| Client core | `pnpm quality:app-core` | `app-core` and `vault-core` reach into no app and read no platform global outside `app-core`'s host adapters. | [ADR 0133](../adr/0133-shared-app-core.md): the PWA and the CLI share it. |
| Design | `pnpm lint:design` | No verb painted on a button, no status pills, no explainer captions. | [DESIGN.md](../../DESIGN.md), [controls](../design/controls.md). |
| Docs index | part of `pnpm quality` | The ADR, audit and evidence indexes match the files. | So the indexes can be trusted. Fix with `pnpm docs:index`. |
| Types | `pnpm typecheck` | Strict TypeScript everywhere. | — |
| Tests | `pnpm test`, `cargo test` | Every suite locally. CI runs the affected packages and crates, plus their dependents. | — |
| Rust lint | `pnpm audit:clippy` | rustfmt, and Clippy pedantic with the complexity limits in `clippy.toml`. | Same budgets as TypeScript. |
| Browser | `pnpm --filter @opensesame/pages verify:<journey>` | Keyboard access, touch layout, local IAM, static boot, auth flow — in real Chromium against a real build. | Unit tests cannot prove a person can use it. |
| Security | `pnpm audit:*` | CVEs, SAST, secrets, dependency budgets, fuzzing, proofs. | [Tooling evaluation](../security/tooling-evaluation.md). |

When a ratchet reports that something **improved**, commit the tightened
ledger (`pnpm quality:gate --update`). Never raise a recorded number to get a
change through.

## Hooks

`pnpm setup:hooks` points git at [`.githooks/`](../../.githooks).

- **pre-commit** — Biome and anti-slop on staged files; rustfmt and Clippy when
  Rust or Cargo configuration is staged; the design lint and `impeccable
  detect` on UI files; gitleaks when installed.
- **pre-push** — `OPENSESAME_PREPUSH=fast` (default: anti-slop lint and plugin
  tests, typecheck, test), `full` (`pnpm verify`) or `off`.

## Team runbooks

| Page | Covers |
|---|---|
| [Agent routines](agent-routines.md) | Scheduled sessions that run audits, fuzz batches and drift checks outside CI, each in a copy-on-write worktree with a workflow swarm and stacked pull requests. |
| [Linear workflow](linear-workflow.md) | Setting up and using the Linear workspace. |
| [PostHog setup](posthog-setup.md) | Setting up product analytics. |
| [AI automation roadmap](ai-automation-roadmap.md) | A dated (2026-08-09) assessment of where AI tooling was used in the development process and where it was meant to go; its status note says what has since changed. |
