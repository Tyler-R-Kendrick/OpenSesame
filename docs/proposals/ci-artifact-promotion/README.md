# Proposal: trunk integration and scheduled artifact promotion

Status: draft for review. Baseline: `aad2c85b4b567fd632d0e409d53d17bb66e8fba4`.
Prepared 2026-10-25, America/Chicago.

## Decision

Keep `main` as the shared integration branch. Make PR/main CI protect the
development baseline. Qualify a selected candidate nightly, then run the
comprehensive prerelease and deep release checks once per weekly release
process. Publish the exact retained production payloads that passed.

This directory is the proposal deliverable. Its YAML files are outside
`.github/workflows`, so reviewing or merging this document does not activate
them. The controller drafts intentionally name planned reusable workflows and
a candidate helper whose implementation contracts are below. They are concrete
designs, not a claim that the new pipeline can already be enabled. Existing
workflow files and repository settings are unchanged by this proposal.

## Read the proposal

| File | Purpose |
|---|---|
| [workflows/ci.yml](workflows/ci.yml) | Proposed fast PR/main controller and stable required check reporters. |
| [workflows/candidate-build.yml](workflows/candidate-build.yml) | Concrete build recipe for the Pages distribution and current two Linux kits, with a complete manifest. |
| [workflows/dev-nightly.yml](workflows/dev-nightly.yml) | Select successful main CI, materialize/reuse one candidate, validate it, and record dev qualification. |
| [workflows/release-weekly.yml](workflows/release-weekly.yml) | Select one dev-qualified candidate; prerelease, mutation/security, and publication dependencies. |
| [migration-map.md](migration-map.md) | Every existing workflow, check allocation, contract-test updates, and cutover requirements. |
| [artifact-builds.md](artifact-builds.md) | Exact artifact recipes, source/profile tests, provenance, and hosting limitations. |
| [candidate-protocol.md](candidate-protocol.md) | Selection, identity, evidence, permissions, and planned helper/reusable interfaces. |
| [validation.md](validation.md) | What was checked on this proposal and what implementation must still demonstrate. |

## Proposed operating policy

| Tier | Trigger | Contract | Failure behavior |
|---|---|---|---|
| Integration | PR/main changes | Affected TypeScript/Rust checks, structural and signature checks, real default bundle measurement. No extra promotion approval. | Required merge checks fail; failed main checks remain visible and take repair priority. |
| Dev | Daily, 00:17 America/Chicago | Select a successful main revision; produce the full candidate once; run complete source checks and representative packaged-product journeys. | No dev-qualified receipt. Existing usable deployments remain available. |
| Prerelease | Thursday, 04:17 America/Chicago | Freeze a recent dev-qualified candidate; run preserved full browser/profile/native/parity coverage. | Stop this candidate before expensive release checks. |
| Release | After prerelease passes in that weekly workflow | Required mutation/security checks pass for the same candidate; production payloads and provenance are verified; publish and verify the destination. | Withhold publication, or report partial publication for repair using the same candidate. |

These times are proposed defaults, not established user preferences. The weekly
time starts qualification; completion and publication are not promised at an
exact clock time. Start earlier if measured runtimes consume the desired release
day. Manual reruns use the same candidate policy; they do not waive checks.

There is no `integration`, `dev`, `prerelease`, or `release` Git branch in this
design. Branches continue to represent work. Qualification is recorded against
candidate identity. Release tags identify approved source revisions.

## Why the expensive build happens nightly

The existing native release matrix allows 90 minutes per target. Starting that
matrix on every incremental main commit would add substantial work to the
current bottleneck. The first proposed producer therefore materializes the full
candidate at the nightly boundary. Fast CI can build its affected source and
measure the default PWA bundle without building every release target.

An integration revision is therefore a source snapshot with fast CI evidence;
it is not automatically a complete release artifact set. The immutable full
candidate starts at the nightly producer, and its bytes are reused through dev,
prerelease, and release. This is a deliberate refinement of the earlier idea of
having all release artifacts available on every main commit.

A complete, retained candidate from the same source and build recipe may be
reused after verifying its entire identity. The controller blueprint includes a
complete-reuse path, whose selector implementation is still required. On a miss,
the producer builds one selected snapshot for that nightly invocation.
Partial reuse of a main PWA build is a later optimization, not implied by a
matching source SHA. It also requires matching configuration, lockfiles,
toolchains, recipe, and complete content hashes.

## First artifact scope

The first implementation covers the two existing publication paths with concrete
recipes: the GitHub Pages distribution and the x86_64/aarch64 Linux release kits.
The candidate includes the bundled env-spec bridge and explicitly separate
test-only proxy archives. Test-only outputs must never be selected as production
executables. Native package names use the prospective stable Cargo version before
qualification, so promotion does not repack a prerelease binary under a new name.

Container and npm publishing are separately accounted for in the migration map.
Their current build-and-publish workflows must become candidate consumers before
those products can claim this guarantee. Until then, disable their legacy
publication entry points during the production cutover. Do not let a new release
tag trigger an independent native/container rebuild and publication.

An unchanged Cargo version can have many nightly candidates, identified by
source/run/attempt. A stable native version can be published only once. An existing
tag/asset with different bytes is a publication failure, never an overwrite.
Release planning must bump versions on trunk before choosing a new stable native
release. The controller should detect a version collision before deep qualification
to avoid spending the weekly budget on an unpublishable candidate.

## What each tier means for hosting

Initially these are qualification channels, not four public Pages sites. The
current Pages build bakes `/OpenSesame/`, its security profile, and canonical
origin into the distribution. Four GitHub environment names do not create four
websites. Moving the build to a different path/origin can require a different
artifact and can change its security assumptions.

The existing production-origin browser harness can route the production URL to
downloaded candidate files inside CI. Use that to test the exact Pages payload
without exposing an unqualified build. Use actual service-worker harnesses for
worker/update behavior because the general routing harness blocks workers.

If continuously available integration/dev/preview URLs are desired, decide their
hosting and browser-storage isolation separately. Preserve production-byte checks
even when additional preview builds are provided. The first cutover makes the
existing public Pages destination the stable release channel.

## Workflow walkthrough

### 1. `ci.yml`: quick shared-development feedback

Retain the three required check names, `TypeScript`, `Rust`, and `Bundle budgets`,
as top-level reporter jobs. Preserve signature checks, draft handling, changed
area/dependency selection, and trusted runner admission. Their success must mean
the required selected jobs succeeded, not merely that downstream jobs were skipped.

For main pushes, scope from the last successfully checked main ancestor to the
selected main SHA. Pending runs can be coalesced, so `github.event.before` alone
can omit changes whose own run never finished. The present no-base behavior runs
everything. A missing/unavailable successful baseline falls back to the full
**fast** suite. Nightly checks cover the complete integrated snapshot; weekly
checks cover every preserved heavy suite.

Move full browser/profile matrices and native platform certification out of the
three PR gates. Actual default bundle measurement stays early. Update documentation
to explain the changed meaning of `Bundle budgets`; it no longer certifies every
browser scenario. Verify the live required status contexts before cutover.

### 2. `dev-nightly.yml`: select and qualify one complete candidate

The controller selects a completed successful main-push CI run at a fixed cutoff,
then resolves its source SHA and exact run attempt. It never uses an unfinished
head just because it is newest. The selection summary lists newer main commits
that were excluded because their required CI has not passed. It checks that the selected commit is on main,
that the producer path is trusted, and that selection does not silently roll an
environment back behind its current qualified revision.

The reusable candidate producer builds that exact revision and returns an immutable
artifact envelope. Dev qualification consumes that envelope, executes complete
source checks plus chosen real artifact journeys, and records a receipt only when
all required results succeed. A failed nightly run is visible even if an old dev
build remains usable.

### 3. `release-weekly.yml`: cumulative evidence on one candidate

Select the newest candidate with a successful dev receipt, initially no more than
48 hours old. Select by source ancestry/cutoff, not job completion order. Fail
clearly if newer work is blocked and no eligible candidate exists. If the latest
eligible candidate is already released, record an explicit no-op.

All subsequent jobs receive the same artifact ID, digest, source SHA, original
run/attempt, and manifest digest. Prerelease must pass before mutation and deep
security start. Independent deep jobs can run concurrently within the runner
budget. Publication depends on every required result. New main commits do not
cancel the active weekly candidate.

The prerelease source/profile suite can compile test variants, Cargo test binaries,
and instrumentation. Those outputs never replace the candidate. Mutation checks
use the source and tests at the candidate SHA. Runtime tests use the retained
production payload wherever the harness supports it.

### 4. `release-publish.yml`: consume the approved bytes

The publisher revalidates evidence, downloads the original artifact, verifies the
complete manifest, verifies expected provenance, checks the tag/version/source,
and publishes the stored production outputs. No application build command belongs
in this job. Preparing Pages' required transport archive is permitted provided
the application file hashes remain identical.

Keep publication credentials in this final workflow's jobs. A validation job does
not need production credentials. A named environment's branch restriction describes
the workflow ref, not the downloaded artifact's origin, so provenance verification
must remain explicit.

Pages deployment and GitHub Release publication are not an atomic multi-system
transaction. Record each component result. On a partial failure, retry the same
qualified candidate idempotently and report which component is live. Do not choose
a newer candidate during recovery. Recovery of stateful clients/data needs its own
tested behavior; retaining a previous binary alone does not reverse a migration.

## Supporting implementation files

| Proposed activation file | Responsibility |
|---|---|
| `.github/workflows/ci-fast-checks.yml` | Extract existing fast jobs and explicit scope outputs; keep required reporters in the caller. |
| `.github/workflows/ci-dev-checks.yml` | Full TypeScript/Postgres source checks and representative candidate journeys. |
| `.github/workflows/ci-prerelease-checks.yml` | Preserve all current browser shards, profile variants, native matrices, parity and complete verification. |
| `.github/workflows/ci-release-checks.yml` | Explicit mutation/security modes, correctly provisioned tools, enforced scanner outcomes. |
| `.github/workflows/release-publish.yml` | Verified artifact consumption and controlled publication. |
| `scripts/release/candidate.mjs` | Selection, authenticated metadata checks, manifest verification, and qualification receipts; no compiler or scanner implementation. |
| `scripts/release/candidate-policy.json` | Expected payload set, trusted producer paths, current policy version, age limits, required gates and allowed scanner dispositions. |

The exact check commands and required contract-test edits are in
[migration-map.md](migration-map.md). This proposal does not implement the reusable
check adapters or the candidate helper. They must land with meaningful tests before
the controller files are moved into `.github/workflows`.

## Cutover sequence

1. **Review this design.** Resolve artifact scope, cadence, and what internal
   channels actually need hosted deployments. These are proposed defaults, not
   unrecorded repository settings.
2. **Implement identity and production recipes.** Test selection and manifest
   rejection cases. Exercise manual candidate builds with no publication.
3. **Extract check workflows and preserve coverage contracts.** Update assertions
   to follow checks to their new owners. Keep critical source checks early; prove
   missing/failed/expired evidence blocks later stages.
4. **Run one representative nightly and weekly qualification without publishing.**
   Capture source SHA, artifact identities, gate completion, runtime and runner
   cost. Fix tool provisioning and scanner error handling before enabling release.
5. **Cut over all relevant triggers together.** Remove the old broad main/PR
   repetitions and independent publishers; activate the reviewed schedules and
   artifact-consuming publisher. Update ruleset configuration and agent instructions
   in the same migration. Verify live settings instead of assuming checked-in JSON
   is already applied.
6. **Observe two weekly cycles.** Compare PR wait time, aggregate runner minutes,
   candidate age, time main stays broken, and first-pass weekly qualification rate.
   Move a frequently failing late check earlier where it pays for itself. Optimize
   repeated source checks only after coverage and evidence are demonstrably preserved.

## Agent and stacked-PR policy changes

Keep isolated worktrees and incremental commits. Stop requiring every internal
implementation slice to become an independently release-certified PR. Reviewable
slices may still be stacked; merge only states that pass the fast integration
contract. Incomplete integration states should be combined or remain draft.

Release qualification is attached to the selected trunk candidate, not to every
commit in every stack. The exact promotion/stacking text in `AGENTS.md` sections 8
and 9, plus contributor routines, must be updated with the CI cutover. Preserve
the verified-signature and review rules. Do not create environment branches.

## Sources

- [Deployment pipeline principles](https://continuousdelivery.com/implementing/patterns/): build packages once and validate deployments.
- [DORA continuous integration](https://dora.dev/capabilities/continuous-integration/): fast feedback and separate longer-running checks.
- [GitHub job dependencies](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs): success dependencies between jobs.
- [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows): schedules, default-branch execution and manual dispatch.
- [GitHub artifact handling](https://docs.github.com/en/actions/tutorials/store-and-share-data): cross-run downloads and retention.
- [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency): independent groups for development and release qualification.
- [Stryker incremental testing](https://stryker-mutator.io/docs/stryker-js/incremental/): reuse and invalidation limitations.
- [Practical Mutation Testing at Scale](https://arxiv.org/abs/2102.11378): targeted, actionable mutation evidence.

Repository-specific observations are pinned to the baseline SHA above. No measured
CI duration distribution, live branch rules, environment settings, or first successful
run of the proposed system is asserted by this draft.
