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
3. **Push.** The pre-push hook runs `pnpm typecheck && pnpm test` by default
   (`OPENSESAME_PREPUSH=off|fast|full`).
4. **Open a pull request.** CI runs three required checks. A user-visible
   change carries before/after evidence
   ([visual-evidence skill](../../skills/visual-evidence/SKILL.md)).
5. **Merge.** Squash only, signed commits, up to date with `main`, review
   threads resolved. `main` then deploys the Pages app and verifies the live
   site serves that exact build.

## CI

`.github/workflows/ci.yml` runs on every pull request. All three jobs are
required.

| Job | Runs |
|---|---|
| **TypeScript** | Commit-signature check, frozen install, `pnpm lint`, `pnpm quality`, `pnpm typecheck`, `pnpm test`, and the product-experience contracts (`pnpm verify:experience`). |
| **Rust** | `cargo +1.88.0 test --workspace --all-targets`. |
| **Bundle budgets** | Builds `apps/pages` and `apps/console`, checks [`tools/quality/bundle-budgets.json`](../../tools/quality/bundle-budgets.json), and runs the Pages browser gates in Chromium: WebMCP, keyboard, mobile, local IAM, SIOPv2. |

`.github/workflows/deploy-pages.yml` publishes `apps/pages` on every push to
`main`. Branch protection is kept as code in [`ops/github`](../../ops/github).

CI is deliberately thin. Heavier checks run locally (`pnpm verify`) and on a
schedule through [agent routines](agent-routines.md).

## The gates, and why each exists

| Gate | Command | Enforces | Why |
|---|---|---|---|
| Lint | `pnpm lint` | Biome formatting and lint on changed files. | One style, no review time spent on it. |
| Anti-slop | `pnpm lint:anti-slop` | No unsafe casts, no `unknown` leaking through APIs, no module mocking. | Type holes are where security bugs hide. |
| Structure | `pnpm quality:gate` | Files ≤ 400 lines; function length, parameters and nesting within budget; the ledger only falls. | [ADR 0093](../adr/0093-structural-quality-gates.md); [guide](../validation/code-quality-gates.md). |
| Coupling | `pnpm quality:packages` | No dependency cycles, no undeclared workspace imports, coupling debt only falls. | Packages that can be understood alone. |
| Client core | `pnpm quality:app-core` | `app-core` and `vault-core` reach into no app and no platform global. | [ADR 0133](../adr/0133-shared-app-core.md): the PWA, CLI and Android share it. |
| Design | `pnpm lint:design` | No verb painted on a button, no status pills, no explainer captions. | [DESIGN.md](../../DESIGN.md), [controls](../design/controls.md). |
| Docs index | part of `pnpm quality` | The ADR and audit indexes match the files. | So the indexes can be trusted. Fix with `pnpm docs:index`. |
| Types | `pnpm typecheck` | Strict TypeScript everywhere. | — |
| Tests | `pnpm test`, `cargo test` | Every suite in both languages. | — |
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
- **pre-push** — `OPENSESAME_PREPUSH=fast` (default: typecheck + test),
  `full` (`pnpm verify`) or `off`.

## Team runbooks

| Page | Covers |
|---|---|
| [Agent routines](agent-routines.md) | Scheduled Claude Code sessions that run audits, fuzz batches and drift checks outside CI. |
| [Linear workflow](linear-workflow.md) | Setting up and using the Linear workspace. |
| [PostHog setup](posthog-setup.md) | Setting up product analytics. |
| [AI automation roadmap](ai-automation-roadmap.md) | Where AI tooling is used in the development process and where it is going. |
