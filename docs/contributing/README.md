# Contributing

How a change gets from a branch to `main`, what checks it on the way, and why
each check exists. The short version is [CONTRIBUTING.md](../../CONTRIBUTING.md);
the rules themselves are [`AGENTS.md`](../../AGENTS.md).

## The path of a change

1. **Branch and build.** `pnpm deps:install`, `pnpm setup:hooks`, then work
   against the package you are changing
   (`pnpm --filter @opensesame/<name> test`).
2. **Commit.** The pre-commit hook lints staged files, runs Clippy when Rust
   is staged, scans for secrets and checks the design contract.
3. **Push.** The pre-push hook runs lint, static quality checks and typechecking,
   plus Clippy when Rust or its configuration changed
   (`OPENSESAME_PREPUSH=off|fast|full`).
4. **Open a pull request.** CI reports three required checks. A user-visible
   change carries before/after evidence
   ([visual-evidence skill](../../skills/visual-evidence/SKILL.md)).
5. **Merge.** Squash only, signed commits, up to date with `main`, review
   threads resolved, through the [Mergify queue](merge-queue.md). Scheduled
   delivery controllers qualify a frozen candidate through environment gates
   before promoting its stored Pages/native artifacts.

## CI

`.github/workflows/ci.yml` builds the affected graph on pull requests, merge
groups and pushes to `main`. Lint, static quality checks and typechecking run in
Git hooks. Unit, integration, browser, coverage, mutation and security suites
qualify delivery to environments through the candidate promotion pipeline.

The required names remain TypeScript, Bundle budgets and Rust for branch-rule
compatibility. They report on every pull request and fail if a selected build
fails or is unexpectedly skipped. Docs-only changes have no affected build.
Affected packages/crates and their transitive dependents are selected by
[`ci-affected-builds.mjs`](../../scripts/lib/ci-affected-builds.mjs); the build
tools compile their prerequisites. Shared build inputs and unreadable scope
fall back conservatively. Main accumulates changes from a successful ancestor,
covering failed, cancelled and coalesced pushes.

| Check | Compilation scope |
|---|---|
| **TypeScript** | Turbo builds affected packages and their prerequisites. No separate lint/typecheck/test step. |
| **Rust** | Cargo builds affected crates and dependents, with their prerequisites. No test targets or Clippy. |
| **Bundle budgets** | Compatibility reporter for the TypeScript build. Actual budgets and browser journeys qualify the candidate during CD. |

Nightly `dev-nightly.yml` builds or reuses a successful-main candidate and runs
development qualification. Weekly `release-weekly.yml` freezes a dev-qualified
candidate for full prerelease, native/mobile, mTLS, browser, coverage, mutation
and security checks. Publication promotes the same stored bytes. A failed
environment gate blocks promotion while integration continues. See
[CI and artifact promotion](../operators/ci-promotion.md) for the complete
delivery contract. Branch protection is maintained in
[`ops/github`](../../ops/github).

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
| Tests | `pnpm test`, `cargo test` | Suites qualify environment delivery; authors can run focused tests locally. | — |
| Rust lint | `pnpm audit:clippy` | rustfmt, and Clippy pedantic with the complexity limits in `clippy.toml`. | Same budgets as TypeScript. |
| Browser | `pnpm --filter @opensesame/pages verify:<journey>` | Keyboard access, touch layout, local IAM, static boot, auth flow — in real Chromium against a real build. | Unit tests cannot prove a person can use it. |
| Security | `pnpm audit:*` | CVEs, SAST, secrets, dependency budgets, fuzzing, proofs. | [Tooling evaluation](../security/tooling-evaluation.md). |

When a ratchet reports that something **improved**, commit the tightened
ledger (`pnpm quality:gate --update`). Never raise a recorded number to get a
change through.

## Hooks

`pnpm setup:hooks` points git at [`.githooks/`](../../.githooks).

- **pre-commit** — Biome and anti-slop on staged files; rustfmt and Clippy when
  Rust or Cargo configuration is staged; the design lint and (when the
  optional skill is installed) `impeccable detect` on UI files; gitleaks
  when installed.
- **pre-push** — `OPENSESAME_PREPUSH=fast` (default: changed-file lint,
  generated-artifact freshness, anti-slop, static quality, typecheck and
  conditional Clippy), `full` (`pnpm verify`, including tests) or `off`.
  The default names static commands directly because the aggregate `pnpm lint`
  and `pnpm quality` aliases also include test suites.

## Team runbooks

| Page | Covers |
|---|---|
| [Command reference](commands.md) | Full command crib sheet moved from `AGENTS.md` §3: per-plane run commands and the Pages `verify:*` trigger and behaviour contracts. |
| [Design rules — full text](design-rules.md) | Full prose behind the one-line invariants in `AGENTS.md` §5. |
| [Security posture — detail](security-posture.md) | Detail behind `AGENTS.md` §6, including external security-checker operation. |
| [Skills index](skills.md) | Routing index for the canonical `skills/*/SKILL.md` sources, moved from `AGENTS.md` §7. |
| [Verification and CI — detail](verification.md) | Detail behind `AGENTS.md` §8; the CI summary above and `.github/workflows/` remain canonical. |
| [Shipping — full procedure](shipping.md) | Full worktree, stacked-PR and done-criteria procedure behind `AGENTS.md` §9. |
| [Cloud agent environments](cloud-agents.md) | Generic cloud-agent environment notes; harness model/subscription routing is not repository policy. |
| [Agent setup](agent-setup.md) | User-scope personal setup (dotfiles, user skills, permissions, tier routing) kept outside tracked product config; profiles, update/rollback, acceptance checklist. |
| [Agent routines](agent-routines.md) | Scheduled sessions that run audits, fuzz batches and drift checks outside CI, each in a copy-on-write worktree with a workflow swarm and stacked pull requests. |
| [Linear workflow](linear-workflow.md) | Setting up and using the Linear workspace. |
| [OSS programs](oss-programs.md) | Open-source program participation notes. |
| [PostHog setup](posthog-setup.md) | Setting up product analytics. |
| [AI automation roadmap](ai-automation-roadmap.md) | A dated (2026-08-09) assessment of where AI tooling was used in the development process and where it was meant to go; its status note says what has since changed. |
| [Merge queue](merge-queue.md) | Mergify queue for this personal account. GitHub's native merge queue is not on the live ruleset. |
| [CI cache](ci-cache.md) | Optional Turborepo remote cache. Fork pull requests and runs without a token stay read-only. |
| [Local sign-off](ci-local-signoff.md) | Optional `basecamp/gh-signoff` preflight. GitHub Actions CI remains the merge gate. |

- [Repository footprint](repository-footprint.md) — source size limits, temporary artifacts, shared skills and lightweight bootstrap.
