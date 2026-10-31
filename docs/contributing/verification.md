# Verification and CI — detail

Detail moved from `AGENTS.md` §8. `AGENTS.md` §8 keeps the before-push and full-gate commands. The CI summary in [Contributing](README.md) and `.github/workflows/` are canonical for workflow behaviour.

## 8. Verification expectations

A local debug session (`dev:web` / attached browser) is how the human
watches the app. It does not replace the merge gates below.

Before pushing:

```bash
pnpm setup:hooks
# Commit: staged lint. Push: static quality + lint + typecheck; tests qualify CD.
```

Authors still run focused local tests for behavior they change.

If the change is user-visible, also capture its evidence and put it in the PR
body — see `skills/visual-evidence/SKILL.md`. The gates prove the contract
holds; the images are the only thing that shows a reviewer what the change
actually did:

```bash
J=work/evidence/unlock/pages/web/journey.json
# Build the base in a separate worktree; point to its dist without swapping sources.
EVIDENCE_DIST=/absolute/path/to/base-worktree/apps/pages/dist \
  PLAYWRIGHT_CHROMIUM=<chromium-binary> \
  node apps/pages/scripts/capture-evidence.mjs capture before "$J"
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
  node apps/pages/scripts/capture-evidence.mjs capture after "$J"
PLAYWRIGHT_CHROMIUM=<chromium-binary> \
  node apps/pages/scripts/capture-evidence.mjs compose "$J"
# Review temporary comparisons, then persist only approved current-state files
# in docs/evidence/unlock/pages/web/ under docs/evidence/README.md's contract.
```

For the full local gate suite (what `pnpm verify` runs — required before
anything security-sensitive lands):

```bash
pnpm verify   # lint + anti-slop (lint and plugin tests) + quality gates
              #   + rustfmt/full-feature Clippy + plugin-boundary + test:all
              #   + cargo +1.88.0 test --workspace --all-targets
              #   + ./scripts/test/battle-test.sh
```

CI lives in `.github/workflows/`. `main` is the integration branch; deployment
channels do not have separate Git branches. The operating contract is
[CI and artifact promotion](../operators/ci-promotion.md).

- `ci.yml` runs on PRs, main pushes, merge groups and demand. It only builds
  the affected TypeScript/Rust graph and its transitive consumers/prerequisites.
  The required check names remain **TypeScript**, **Rust**, and **Bundle budgets**;
  the last is a compatibility reporter for the TS build, not a budget gate.
  Tests, lint, standalone typechecks, quality checks, browser journeys and scans
  never gate trunk. GitHub's ruleset still requires verified commit signatures.
  Main's diff starts at a verified successful ancestor, covering failed,
  cancelled and coalesced pushes. Active main builds finish; superseded PR builds
  cancel. Missing or unexpectedly skipped selected work fails the reporter.
- `.githooks/pre-commit` checks staged source. The default push hook runs static
  lint, quality, typechecking and relevant rustfmt/Clippy without test aliases.
  `OPENSESAME_PREPUSH=full` is an explicit local `pnpm verify` opt-in.
- `dev-nightly.yml` runs at **00:17 America/Chicago**, or on demand from `main`.
  It selects successful push-main builds, builds or reuses one complete candidate,
  then qualifies the full TypeScript/Postgres suite and stored native/Pages
  artifacts. Evidence binds the candidate, run, attempt and digests.
- `release-weekly.yml` runs Thursday at **04:17 America/Chicago**, or on demand
  from `main`. It freezes one dev-qualified candidate; prerelease, mutation,
  security and publication are one dependency graph. New main work never replaces
  or cancels that candidate. The `release` and `github-pages` environments protect
  publication and must permit the controller's `main` ref.
- `ci-prerelease-checks.yml` retains the complete browser/profile/viewport/tutorial/
  live matrices, Android/Apple, mTLS, `pnpm verify`, parity, native platforms,
  containers, native-Wasm, coverage, sync authorization, autofill and exact-artifact
  smoke. Every declared result must succeed. These suites run for CD, not trunk.
- `ci-release-checks.yml` retains scoped TS/duress/Rust mutation and full security:
  dependencies, structural/Semgrep SAST, secrets, six-language CodeQL, Kani, Miri,
  Shuttle and coverage-guided Rust/TS fuzzing. Missing tools, scanner errors,
  incomplete reports, fallback fuzzing and unexpected skips fail qualification.
  No budget, coverage or mutation threshold is lowered.
- `candidate-build.yml` builds and attests the immutable production candidate.
  `release-publish.yml` verifies qualification receipts and publishes those bytes
  without rebuilding. Retired publishers still refuse publication; OCI/npm need
  candidate-bound producers and qualification before publishing is restored.
- CodeQL monitoring remains scheduled/manual. Sync authorization and autofill
  have manual/reusable entry points and qualify the selected prerelease source.
  `security.yml` retains independent repository-history/Scorecard monitoring.

Authors run focused local tests for behavior they change. Tests qualify delivery
without blocking ongoing integration. A draft PR builds nothing and its reporters
fail; existing owner-only self-hosted build eligibility remains. Production
candidate builds and publication stay GitHub-hosted. See
[ADR 0215](../adr/0215-trunk-builds-only.md) for the build-only trunk contract.

Host the work itself as §9 describes: a copy-on-write worktree, a workflow swarm, stacked pull requests, a disk check after every commit, verified commits. Detail: [shipping](shipping.md).

