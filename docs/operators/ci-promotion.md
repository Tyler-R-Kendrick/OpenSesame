# CI and artifact promotion

OpenSesame integrates continuously on `main`. A candidate is a fixed source
revision and complete immutable artifact set. Nightly and weekly jobs qualify
that identity; publication consumes the same bytes. See
[ADR 0214](../adr/0214-trunk-ci-artifact-promotion.md) and
[ADR 0215](../adr/0215-trunk-builds-only.md).

## Cadence and ownership

| Stage | Entry point | Trigger and required work |
|---|---|---|
| Integration | `ci.yml` | PR, merge group, main push or manual: compile affected TypeScript packages/Rust crates, their transitive consumers and build prerequisites only. |
| Dev | `dev-nightly.yml` | Daily **00:17 America/Chicago**, or manual on main: select successful main CI, build/reuse complete artifacts, full TS/Postgres and production Pages/native smoke. |
| Prerelease | `ci-prerelease-checks.yml` | Called by weekly: all former CI browser/native jobs, complete verification, parity, real platforms, cold native-Wasm, container validation, sync authorization, autofill, coverage and artifact smoke. |
| Release qualification | `ci-release-checks.yml` | After prerelease: separate required mutation and security matrices, each with its own receipt. |
| Publication | `release-publish.yml` | After both deep suites: revalidate evidence, stage a native draft, pass the release environment gate, deploy unchanged Pages files, verify live content, publish native assets. |

`release-weekly.yml` runs Thursday at **04:17 America/Chicago**, or manually on
main. Both schedules declare that timezone and follow daylight saving changes.
GitHub scheduling can run late: dependencies and candidate identity determine
order. A missing eligible candidate fails visibly. Jobs never independently
select whatever happens to be latest when they start.

The weekly controller stores its first successful selection as an immutable
artifact. Rerunning all jobs in that same run retains that candidate and original
dev receipt even if a newer nightly candidate exists. The retry verifies the
original selection job and artifact, then checks source, policy, provenance,
freshness and publication state again. Missing or expired selection evidence
fails rather than allowing a different candidate to take its place.

These are qualification states, not extra Git branches or four hosted websites.
The production PWA bakes `/OpenSesame/`, its shared-origin profile and canonical
origin. Browser qualification serves that package through the existing harnesses.
A distinct origin/profile needs a distinct artifact and corresponding evidence.

## Build-only integration

Protected check names remain **TypeScript**, **Rust**, and **Bundle budgets** for
compatibility with the existing ruleset and candidate admission. TypeScript
reports the affected package build, Rust reports the affected crate build, and
Bundle budgets reports that same TypeScript build result. The budget name is a
legacy alias; budget measurement now runs only during delivery qualification.
Reporters require successful scope resolution and every selected build to
succeed. Unexpected skips, cancellations or missing decisions fail. Draft PRs
run no builds and deliberately fail the reporters.

The build planner selects changed packages/crates plus their transitive consumers.
Turbo's `^build` dependencies and Cargo compile prerequisites. Shared build
inputs, dependency lockfiles, removed manifests or an unreadable diff select a
conservative full build. Documentation and lint-only changes compile nothing.
Pages builds once through its ordinary build recipe; it has no separate
`tsc --noEmit` pass. TypeScript library compilation still emits declarations and
JavaScript through its normal compiler.

Trunk does not start databases, tests, browser journeys, quality ratchets,
standalone typechecks, lint, budget measurements or security scans. Install local
Git hooks with `pnpm setup:hooks` (also part of bootstrap). The commit hook checks
staged source; the default push hook runs static lint, quality, typechecking and
relevant Rust formatting/Clippy without test suites. Full local verification
remains an explicit opt-in. GitHub's required-signatures ruleset enforces commit
signatures independently of the build workflow.

Main runs finish; superseded PR runs can cancel. Pending main runs can coalesce,
so main scope starts at a verified successful ancestor and includes intervening
failed/cancelled pushes. An unavailable baseline builds both full graphs.
Integration does not wait for development or release qualification. Development
runs full TypeScript/Postgres suites and exact-artifact smoke. Prerelease runs the
complete browser/native suite, budgets, sync authorization and autofill; release
qualification adds mutation and security. Those reusable workflows have no PR,
merge-group or main-push triggers. Scheduled repository monitoring and manual
investigations remain independent.

## Build and identity

The producer accepts a source SHA and exact successful push-main CI run/attempt.
It checks workflow, repository, branch, ancestry, required gates and policy.
PR, fork or manual CI evidence cannot impersonate source admission.
Selection follows at most 100 first-parent commits from the captured main tip;
historical merge commits are allowed, but their side-branch parents are never
searched for a conveniently green run. An exhausted search fails visibly.

The immutable envelope carries `candidate_id`, `source_sha`, producer `run_id`
and `run_attempt`, `artifact_id`, `artifact_digest`, and `payload_digest`.
`candidate.json` lists prospective stable version, source, controller revision
and every file's path, role, target, size and SHA256. `payload_digest` hashes its
exact bytes. The Actions artifact ID/ZIP digest stay outside the manifest to
avoid a circular hash.

The complete candidate has six payloads: production Pages archive, standalone
bundled env-spec bridge, x86_64 and aarch64 Linux kits, and two separately named
TEST proxy archives with `upstream-override`. TEST downloads remain available
for downstream validation and cannot become production executables. Native
smoke runs the archived host/bridge and rejects an unsafe writable bridge.

Every intermediate/final download checks authenticated metadata and ZIP SHA256
before extraction. Manifest validation rejects extra/missing files, wrong
source/profile, bridge mismatch and test/prod substitution. Extraction rejects
traversal, links, duplicates, oversized archives and populated destinations.
GitHub's warning-only download digest reporting cannot authorize promotion.

Original build attestations bind selected source separately from workflow
revision: main may advance while source is selected. Verification pins the
candidate-builder signer, main ref, controller digest, hosted runner and exact
candidate claim. Later promotion has a separate signed predicate and never
claims the publishing job built the files.

Complete candidates/receipts retain **35 days**; intermediate uploads seven.
Published releases retain their own assets. Retention is separate from freshness:
dev evidence must be no older than **48 hours**, while unchanged older source
can receive fresh evidence through a new nightly invocation.

## Required evidence

A receipt binds the entire candidate envelope, current policy digest,
controller run/attempt, prerequisite receipt and completed gate job ID. Each
gate depends on the complete expected suite and accepts only success. Security
and mutation have distinct suite identities and cannot substitute for each other.

Within an active weekly run, verification checks completed prerequisite jobs
in that exact attempt; demanding completion of the whole active workflow would
deadlock. Cross-run evidence must come from a completed successful attempt.
Reruns cannot borrow old attempt receipts.

Policy compatibility covers workflow recipes, protocol helpers and executable
audit/fuzz guards. Changes invalidate incompatible evidence; successful main CI
and fresh nightly qualification must establish the new policy.

The release gate preserves coverage/mutation floors and requires scoped TS,
duress and Rust mutation; OSV/RustSec and cargo-deny dependency policy;
structural/Semgrep SAST; full-history secret scanning; six-language CodeQL;
Kani, Miri, Shuttle and native coverage-guided Rust/TS fuzzing. Missing tools,
scanner errors, malformed reports, incomplete fuzz scope and degraded fallback
runs fail. Corresponding jobs retain tools, scope, timestamps, reports and logs.
External model reviews, Deepsec investigations and cve-lite's local workflow
remain supplemental; this pipeline does not claim those reviews occurred.

The CodeQL gate retains two reviewed JavaScript HMAC findings on the historical
`660eef2b47734044b89992721059dbfd85c86b9f` source. Their complete SARIF result
digests, language categories and source inputs are recorded together in
`scripts/release/codeql-reviewed-inputs.json`. The input digest covers every Git
tree entry, including mode and object ID, except that review-record file itself.
This exception lets a later controller record an independently reviewed source
without requiring the record to contain its own digest. The record is part of
the compatibility policy and must match the trusted controller. No native TLS
result is currently authorized by this record. The historical record preserves
review evidence; it does not make that commit releasable under the current
controller when its policy inputs differ.

A retained finding qualifies only when its complete result digest, category and
candidate input digest match the trusted controller's review record and its
hard-coded eligible-result map. A changed input or unrecorded result therefore
requires a fresh review if the finding remains; a clean report does not require
a record for its input digest. After reviewing complete dataflows, dependencies,
analyzer output and source, compute the candidate input digest with the trusted
controller's `candidateTree` and `candidateSourceDigest` functions. Update the
controller-owned eligible-result map and record only for the exact reviewed
result, category and input digest, as appropriate. Updating the record alone
cannot authorize a result absent from the eligible-result map. Changing only the
record leaves the input digest stable. This process retains and does not dismiss
SARIF. Missing evidence, additional findings and analysis/extraction errors also
fail. Candidate build processes currently run on the analysis runners; a separate
trustworthy analysis provenance boundary is still needed before these reports can
establish isolation from such code.

## Operating a release

1. Merge the intended `major.minor.patch` Cargo workspace version before the
   nightly candidate build. Versioned filenames and embedded versions are fixed
   before qualification, not rewritten during publication.
2. Wait for nightly qualification, or manually dispatch `dev-nightly.yml` on
   main. Its summary identifies selected source and excluded newer main work.
3. Let Thursday's controller run, or manually dispatch `release-weekly.yml` on
   main. Manual dispatch uses the same gates/concurrency and is the urgent path.
4. Review the immutable candidate run linked by the `release` environment,
   then approve staging. The draft and tag are created only after that approval.
5. After Pages verification, review the draft and approve the `release`
   environment again for final publication. Confirm all publishing jobs finish. Exact release assets/checksums, original
   build proof, receipts and promotion attestation accompany the native release;
   served Pages content must match the qualified files.

Another source or changed payload bytes under an existing version is a collision.
Published assets cannot be overwritten. Identical already published payloads
produce a visible no-op only after verifying publication completeness. New
producer IDs alone do not force a version bump for unchanged source/bytes.
Release notes are generated while staging the draft; the final publication approval
can serve as editorial review. A tag push does not start another build or publish.

## Recovery

| Failure | Required recovery |
|---|---|
| Main CI fails | Fix or revert on main; subsequent scope includes unchecked changes. |
| Nightly build/dev fails | No new dev receipt; fix and dispatch nightly again. Integration continues. |
| Prerelease/deep check fails | Publication stops. Fix source, then qualify its new candidate; never waive an absent report. |
| Artifact expires or policy changes | Rebuild/requalify compatible source through nightly. |
| Draft publication is interrupted | Rerun the whole weekly workflow. It retains the original selection and regenerates qualification receipts for the current attempt while the original dev evidence is still fresh. Resume only that candidate's unpublished draft; product bytes stay immutable. |
| Pages succeeds but native publication fails | Publication across products is not atomic. Repair and rerun the full weekly graph to verify the same bytes and finish the draft. |
| Version/tag belongs elsewhere | Choose a new source version; never move/overwrite a published release to pass a gate. |

Normal promotion refuses a source behind an existing release. An emergency
forward fix uses the manual controllers. A dedicated rollback mode would need
explicit selection, compatibility checks, evidence and policy; it is not an
unguarded option in this implementation.

If the frozen dev receipt becomes older than 48 hours, the original weekly run
cannot borrow a newer receipt. Obtain fresh nightly qualification and start a
new weekly invocation. It can resume the draft if it selects the same candidate
identity, as happens when unchanged main reuses its complete artifact. If source
or artifact identity changed, use a new stable version and forward qualification;
do not move the reserved tag or rebind the old draft. A rebuild is not guaranteed
to reproduce identical binary bytes merely because its source is unchanged.

## First activation and repository settings

The code cutover retires `deploy-pages.yml`, `release-kit.yml`,
`publish-containers.yml`, `publish-npm.yml` and the local rebuild-and-push script.
Their old entry points now fail with a migration message. OCI/npm publication
is paused until exact artifacts and qualification join the candidate inventory;
container build validation remains in prerelease.

Before the first hosted release, verify existing external settings:

- Preserve verified signatures, up-to-date PRs, squash and the same three main
  required checks. Do not weaken protection to activate the new workflows.
- Pages must use Actions. The `release` and `github-pages` environments must
  allow the controller's **main branch**, not only `v*` tags. Preserve existing
  required reviewers.
  The reviewed proposals are `ops/github/release-environment.json` and
  `ops/github/release-environment-branches.json`; the latter allows only
  `main`. Separate `v*` tag rulesets govern creation and mutation.
- CodeQL must use advanced setup for these uploads; default setup must not
  independently own them.
- Actions must permit the narrowly scoped contents/Pages/attestations/OIDC and
  code-scanning permissions requested by the specific jobs.
- Verify both configured tag rulesets with `node ops/github/governance.mjs --verify`:
  `opensesame-release-tag-creation` allows only owner/admin and Actions app 15368
  to create a version reservation; `opensesame-release-tags` allows only the
  owner/admin to move or delete it. Never add the Actions bypass to the mutation
  ruleset. An owner-created tag at the exact verified source remains supported.
  Checked-in policies are proposals until live application and verification
  succeed; denied settings access must block activation, not relax protection.
- Review external provider Git integrations separately: a Vercel or similar
  main-triggered rebuild is outside this publisher and this weekly cadence.

The implementation does not assert that external settings were changed. Its
first release must run on GitHub after verified merge. Local negative controls
prove rejection logic, not platform qualification or an actual deployment.

The read-only settings inspection for this change found the protected-main
ruleset and its three existing required checks, no tag ruleset, and a
`github-pages` environment that permits `main` without required reviewers.
There was no `release` environment. These settings were not modified. An
administrator must apply the reviewed owner-required-reviewer policy, disabled
admin bypass and main-only deployment branch policy before promotion can run.
Naming an environment in YAML does not establish those protections: GitHub can
create an unprotected environment automatically.

`release-environment.mjs` reads the live `release` environment and its complete
deployment branch policy before publication admission, draft staging, and every
publication job. It checks the exact owner reviewer (User `145080887`), the
approved self-review setting, disabled admin bypass, and the sole allowed
`main` branch. It rechecks after the environment wait, immediately before Pages
deployment, and in the publisher before draft/native release writes. Missing,
unprotected, mismatched or unreadable configuration fails closed; no environment
is created or repaired by this guard. An HTTP 403 remains an administrator setup
issue, never a reason to continue without approval. Both REST reads require only
`actions: read`, already scoped to these jobs; no administration write permission
or additional credential is needed. GitHub documents the read permission for
[Get an environment](https://docs.github.com/en/rest/deployments/environments#get-an-environment)
and [List deployment branch policies](https://docs.github.com/en/rest/deployments/branch-policies#list-deployment-branch-policies).

A release-environment approval precedes draft and tag staging. Pages waits for
that staging, and a second release-environment approval precedes native publication. The schedules become active when these
files reach main, but release promotion stays blocked until the live approved
protections are configured and readable.


## References

- [GitHub artifact transfer](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [Deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Native release verification](release-kit.md)
- [Repository rulesets](../../ops/github/README.md)
