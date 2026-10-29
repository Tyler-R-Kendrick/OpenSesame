# Verification and CI — detail

Detail moved from `AGENTS.md` §8. `AGENTS.md` §8 keeps the before-push and full-gate commands. The CI summary in [Contributing](README.md) and `.github/workflows/` are canonical for workflow behaviour.

## 8. Verification expectations

A local debug session (`dev:web` / attached browser) is how the human
watches the app. It does not replace the merge gates below.

Before pushing:

```bash
pnpm lint && pnpm quality && pnpm typecheck && pnpm test
```

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

- `ci.yml` runs on PRs, main pushes, merge groups and demand. The required check
  names remain **TypeScript**, **Rust**, and **Bundle budgets**. It preserves
  signatures, approved evidence, repository/skills checks, affected TypeScript
  packages and Rust crates/dependents, actual default Pages budget measurement,
  and affected default-build trust journeys. It does not run the broad browser,
  native-platform, CodeQL, coverage or mutation matrices for every PR. Main's
  changed scope starts at a verified successful ancestor, covering failed,
  cancelled and coalesced pushes. Active main runs finish; superseded PR runs
  cancel. Missing or unexpectedly skipped selected work fails the reporter.
- `dev-nightly.yml` runs at **00:17 America/Chicago**, or on demand from `main`.
  It selects successful push-main CI, builds or reuses one complete candidate,
  and calls `ci-dev-checks.yml`: the full TypeScript/Postgres suite plus browser
  and native smoke of the stored production artifacts. It records exact
  candidate/run/attempt/digest qualification evidence.
- `release-weekly.yml` runs Thursday at **04:17 America/Chicago**, or on demand
  from `main`. It freezes one dev-qualified candidate; prerelease, mutation,
  security and publication are one dependency graph. A new main commit cannot
  replace or cancel that candidate. The `release` and `github-pages`
  environments protect the actual publishing jobs; environment settings must
  permit the controller's `main` ref.
- `ci-prerelease-checks.yml` preserves the complete former 17-job CI suite,
  all browser profiles/viewport/tutorial/live matrices, Android/Apple, mTLS,
  complete `pnpm verify`, password parity, actual native platform tests,
  container build validation, native-Wasm cold validation, measured TS/Rust
  coverage, autofill-extension browser checks and exact-artifact smoke. Every
  declared result must succeed.
- `ci-release-checks.yml` runs the existing scoped TS, duress and Rust mutation
  gates, then requires the selected security mode's full matrix: OSV/RustSec and
  dependency policy, structural/Semgrep SAST, secret scans, six-language CodeQL,
  Kani, Miri, Shuttle and coverage-guided Rust/TS fuzzing. Mutation and security
  follow prerelease and can run concurrently. Missing tools, scanner errors,
  incomplete reports, fallback fuzzing and unexpected skips fail qualification.
  No budget, coverage or mutation threshold is lowered.
- `candidate-build.yml` stamps Pages and packs the existing x86_64/aarch64 Linux
  kits once, keeping TEST proxy archives separately named. Original build
  attestations bind the actual selected source as well as the controller
  revision. `release-publish.yml` verifies the entire candidate and its chain of
  qualification receipts, and publishes those bytes without building again.
  `deploy-pages.yml`, `release-kit.yml`, the old OCI/npm publishers and the local
  rebuild-and-push script now refuse publication. OCI/npm must first gain
  candidate-bound producers and qualification before publishing is restored.
- `security.yml` remains independent repository-history/Scorecard monitoring.
  `sync-target-security.yml` and `autofill-browser.yml` retain their targeted
  early authorization regressions.
  Manual agent investigations remain supplemental; a dashboard upload or model
  review does not substitute for a required deterministic release check.

The integration check names describe their fast scope. References elsewhere in
this document to built browser matrices refer to mandatory prerelease coverage;
authors still run the focused local journeys for behavior they change. A draft
PR runs no heavy suite and its required reporters fail. Existing owner-only
self-hosted selection is retained for eligible fast TS/Rust work; production
candidate builds and all publication stay GitHub-hosted.

A green integration PR can merge without waiting for the weekly release. A failed
release gate blocks publication, not ongoing integration. Keep the work hosted
as §9 describes and do not bypass signatures or required checks.

Host the work itself as §9 describes: a copy-on-write worktree, a workflow swarm, stacked pull requests, a disk check after every commit, verified commits. Detail: [shipping](shipping.md).

