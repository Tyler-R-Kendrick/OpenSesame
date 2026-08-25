# Contributing

## Prerequisites
- Node.js ≥ 22 (CI uses 22; Node 24+ preferred locally)
- pnpm 9 via Corepack
- Rust 1.88 for the authority plane
- Optional: Docker for Compose / Testcontainers

## Workflow
```bash
pnpm install
pnpm --filter @opensesame/control-plane test
pnpm -r --filter '@opensesame/*' test
cargo +1.88.0 test --workspace --lib
```

Identity CLI binary is `opensesame-id` (Rust authority CLI remains `opensesame`).

## Local gates (no CI)
This repo intentionally runs **no GitHub Actions** — there is no `.github/` workflow
directory, and none should be added. Verification instead happens through:

- Local git hooks (below), run on every commit and push.
- `pnpm verify`, runnable locally or on demand, for the full gate suite.
- Opt-in deeper gates (not in `verify`): `pnpm audit:fuzz`, `pnpm test:fuzz`,
  `pnpm audit:kani`, `pnpm audit:miri`, `pnpm audit:shuttle`. See
  `docs/validation/fuzzing.md`.
- Scheduled Claude Code cloud sessions that run audits and report findings on a
  cadence — see `docs/operations/agent-routines.md` for the configured routines.
- [CodeRabbit](https://coderabbit.ai), already installed as a GitHub App, which
  reviews pull requests on its own infrastructure (not billed against Actions minutes).

### One-time setup
After cloning, run once:
```bash
pnpm setup:hooks
```
This points git's `core.hooksPath` at the repo's tracked `.githooks/` directory and
makes the hook scripts executable. `pnpm bootstrap` now runs this automatically, so a
fresh clone that runs `pnpm bootstrap` does not need a separate step.

### What the hooks do
- **`pre-commit`** — runs `biome check` and anti-slop against staged files,
  runs the full Rust formatting and Clippy gate when Rust or Cargo configuration
  is staged, then
  the gitleaks secret scan (`scripts/gitleaks-gate.sh`) if the
  `gitleaks` binary is available on `PATH`; otherwise it prints a one-line notice and
  continues. On failure it prints remediation hints (e.g. run `pnpm lint:fix` and
  re-stage).
- **`pnpm lint:anti-slop`** — Oxlint with the vendored anti-slop plugin
  (`tools/oxlint/anti-slop/`, config `oxlint.config.ts`). It is part of
  `pnpm lint:all`, both hooks, and `pnpm verify`; nested configs and unused
  disable directives fail the gate. `pnpm test:anti-slop` runs every plugin
  RuleTester case and verifies the installer assets match the vendored copy.
- **`pnpm audit:clippy`** — checks `rustfmt` and runs Rust 1.88 Clippy across
  every workspace target and feature. Warnings, the full pedantic group, and
  the complexity thresholds in `clippy.toml` fail the gate. Prefer fixing the
  shared responsibility; use a narrow `#[expect(clippy::lint, reason = "...")]`
  only when a cohesive declarative table or test matrix is clearer unsplit.
- **`pre-push`** — runs a verification pass sized by the `OPENSESAME_PREPUSH`
  environment variable:
  - `off` — skip entirely.
  - `fast` (default when unset) — `pnpm typecheck && pnpm test`.
  - `full` — `pnpm verify` (the complete local gate, including Rust formatting,
    Clippy, and Rust tests).

  Set your preferred mode with `export OPENSESAME_PREPUSH=off|fast|full` (e.g. in your
  shell profile) to change it from the default.

## Design rules
- Domain package (`@opensesame/os-domain`) must not import Better Auth, oidc-provider, Hono, Drizzle, or React.
- Prefer mature libraries over NIH protocol code (ADR 0008).
- Do not add Clerk/Marketplace auth as core (ADR 0004).
- Record consequential decisions as ADRs under `docs/adr/`.

## Configuration
Copy from `.env.schema` guidance; never commit live secrets. Development signing keys and claim peppers must be generated outside Git.
