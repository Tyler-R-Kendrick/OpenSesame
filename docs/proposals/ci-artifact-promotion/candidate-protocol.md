# Candidate protocol and implementation contracts

This is the planned contract for `scripts/release/candidate.mjs`, its policy data,
and the reusable check/publish workflows. The helper and adapters are not implemented
by this design-only change. The workflow blueprints must not be activated until
these contracts have implementations and adversarial verification.

## Candidate identity

The producer writes `candidate.json` with this shape:

```json
{
  "format": "opensesame-candidate",
  "schema_version": 1,
  "candidate_id": "<source-sha>-<producer-run-id>-<producer-run-attempt>",
  "source_sha": "<40 lowercase hex characters>",
  "version": "<prospective stable Cargo workspace version>",
  "producer": {
    "run_id": "<numeric string>",
    "run_attempt": "<numeric string>",
    "workflow_ref": "<actual GITHUB_WORKFLOW_REF>",
    "workflow_sha": "<actual workflow revision>",
    "recipe_path": ".github/workflows/candidate-build.yml"
  },
  "source_ci": {
    "run_id": "<numeric string>",
    "run_attempt": "<numeric string>"
  },
  "payloads": [
    {
      "path": "<relative regular-file path>",
      "role": "production",
      "target": "<platform or pages>",
      "sha256": "<64 lowercase hex characters>",
      "size": 123
    }
  ]
}
```

The example is a shape illustration, not a qualification record. The producer
draft's emitted manifest is the concrete reference for exact payload names.

The Actions artifact ID/digest are returned *after* upload and form an external
envelope. They must not be embedded in the artifact they identify; doing so would
create a circular hash dependency. The blueprint output `payload_digest` is the
SHA-256 of the exact `candidate.json` bytes, which enumerate the payload hashes.
Do not reserialize that JSON and expect its byte digest to stay the same.

The envelope carries: expected repository, source SHA, candidate ID, producer run
and attempt, artifact ID, upload artifact digest, and manifest digest. The repository
is supplied by the trusted controller and verified against GitHub API metadata;
an artifact's own claim of repository or origin is insufficient.

An action-run ID belongs to the top-level workflow even when a reusable workflow
does the build. The trusted producer allowlist must therefore include the intended
nightly controller and the deliberate manual build entry point. Do not falsely
require GitHub API `run.path` to equal the reusable file's path.

## Selection

### Main source selection

Select completed, successful `push` executions of `.github/workflows/ci.yml`
against `main` in this repository, using the captured run attempt and a cutoff
recorded when selection begins. Reject a PR, fork, untrusted workflow path,
incomplete run, cancelled run, unexpected branch, or mismatched SHA.

Fetch enough pages to make the decision meaningful. If a safety limit is reached,
fail with an explicit incomplete-selection result; do not silently claim an older
candidate was the newest. Resolve source ordering by main ancestry, not by finish
time. A slow old build can finish after a newer build.

Validate the selected source against the actual current main history. Never add an
environment branch. Pin `source_sha`, `source_ci_run_id`, and `source_ci_run_attempt`
once. New main commits after selection do not replace those inputs.

### Weekly candidate selection

Locate dev receipts emitted by the trusted nightly workflow. Validate their schema,
the source/build identity, the producing workflow/run/attempt, the stage's policy
version, and the successful completion of every required stage job. A file named
`dev-qualified.json` is not, by itself, evidence of success.

Require an available, unexpired complete artifact and a dev qualification completed
within the policy age limit (initial proposal: 48 hours). Old source can be retested
and receive fresh evidence; source age alone is not a failure. Published-candidate
selection must not roll back behind the current release unless an explicit recovery
operation is used. An already released identical candidate produces a visible no-op.

Check that the prospective stable version is available before spending the deep
qualification budget. An existing tag or native asset with other bytes is a collision.

## Materialization and verification

1. Check GitHub metadata: expected repository, workflow path/ref, source SHA, run
   attempt, artifact name/ID, upload time, expiration and run conclusion appropriate
   to the producer. For a same-run build consumed before that run completes, validate
   its producer job dependencies and outputs; require full run success when later
   workflows reuse it.
2. Download by the original artifact ID/run, never an unscoped `latest` name.
3. Verify the upload digest with a hard failure. GitHub documents a download digest
   mismatch as a warning, so do not rely on that warning to authorize release.
4. Verify the exact manifest digest against the trusted envelope.
5. Validate schema and identity, reject unknown roles and duplicate payload paths/entries,
   require the exact expected set, compare every file's size and SHA-256, reject
   extra files as well as missing files, and reject symlinks/traversal on extraction.
6. Extract into a private candidate directory. Test copies may be writable; the
   retained artifact is never overwritten by test variants or mutant builds.

The current Pages live marker covers only selected served files. It is useful for
the post-deployment source/config check but cannot replace the whole-package manifest.

## Qualification receipts

A receipt identifies:

- Schema version and stage (`dev`, `prerelease`, or `release-qualified`). A deep
  receipt additionally binds its exact `suite` (`mutation` or `security`).
- Complete candidate envelope, including the source and manifest digests.
- Trusted controller/workflow revision and qualification-policy revision.
- Check run IDs/attempts, completion time, required scope and result per check.
- Environment/profile/toolchain when relevant; scanner version/database timestamp
  for checks whose result depends on changing external data.
- Explicit skipped checks only when the current policy declares them inapplicable.

Write the receipt only from a job that depends on every required check and explicitly
confirms successful results. No `continue-on-error`, fallback success, missing
report, unexpected skip or incomplete scan can create a passing receipt. Always-run
summary jobs may report failure but must not authorize promotion.

Results describe the same candidate throughout a weekly run. Mutation/source
analysis checks out the candidate SHA; artifact/runtime checks consume its package.
Neither uses the scheduled event's `github.sha` as a substitute for candidate identity.

Store receipts as Actions artifacts with retention covering qualification and
recovery. Start with 35 days for complete nightly candidates and their receipts,
matching the existing release-artifact retention; reduce retention of unselected
intermediate output. Measure storage use and retain only useful candidates. Stable
release packages remain available through their release publication.

## Proposed reusable workflow boundaries

| Workflow | Inputs | Outputs/contract |
|---|---|---|
| `ci-fast-checks.yml` | Source/base SHA, event/draft classification and selected scopes. | Explicit TypeScript/Rust/bundle/preflight results and applicability. No publication credentials. |
| `candidate-build.yml` | `source_sha`, `source_ci_run_id`, `source_ci_run_attempt`. | Complete immutable envelope. Concrete draft included. |
| `ci-dev-checks.yml` | Complete candidate envelope. | All required dev jobs succeed; no qualification bypass. |
| `ci-prerelease-checks.yml` | Complete candidate envelope. | Preserved complete source/profile/browser/native checks; all expected jobs and profiles present. |
| `ci-release-checks.yml` | Complete envelope, explicit `mutation` or `security` mode. | Mode-specific required tools, reports and scope succeed; no mode silently omitted. |
| `release-publish.yml` | Complete envelope plus qualified evidence identity. | Pages/native publication, exact version/source/provenance checks, post-deploy verification and per-product receipt. |

Use typed `workflow_call` inputs. Do not inherit all secrets into a general-purpose
test workflow. Put environment access on the actual job that needs it. Do not give
source/mutation jobs production publication privileges.

The controller helper commands and environment variable names are specified by
the drafts; their implementations must validate every input before using it in a
path, shell argument, GitHub output, tag, or API request. Pass expressions via
environment/input fields, not interpolated untrusted shell text.

### Controller helper commands

| Command | Required behavior |
|---|---|
| `policy --controller dev-nightly` | Reject an unimplemented/disabled policy, wrong repository, or non-main controller ref. Validate the producer allowlist, expected payload inventory and retention. |
| `policy --controller release-weekly` | The same admission checks, plus implemented publication/provenance verification and removal of legacy publication bypasses. No green success obtained by silently skipping publication. |
| `select-integration --workflow .github/workflows/ci.yml --reuse-complete --output <path>` | Emit `source_sha`, `source_ci_run_id`, `source_ci_run_attempt`, and a validated `reuse=true|false`. If reusing, also emit the original complete candidate envelope. Old source CI is allowed when current policy remains compatible; fresh dev qualification still runs. |
| `select-dev --workflow .github/workflows/dev-nightly.yml --max-age-hours 48 --output <path>` | Emit the candidate envelope, `dev_receipt` JSON envelope, and `promote=true`. Already-published identical bytes emit `promote=false` and an explicit no-op summary. Missing eligible evidence is a failure, not a no-op. |

Each source/receipt selection records a fixed cutoff and reports any newer main
work excluded by incomplete or failed prerequisites. Source CI freshness and dev
qualification freshness are distinct: an idle main must still be retestable.

The `ci-fast-checks.yml` interface accepts `test_sha`, `change_head_sha`,
`change_base_sha`, and boolean `draft`; it emits `typescript_verdict`,
`bundle_verdict`, and `rust_verdict`. Only the literal `pass` authorizes the
caller reporter. Empty main base means resolve the last successful checked main
ancestor, then include the cumulative diff; missing history selects all fast tests.

Dev/prerelease/deep reusables receive all seven candidate identity fields. Dev
also receives numeric `receipt_retention_days`. Prerelease and deep jobs receive
`prerequisite_receipt`; deep jobs receive a fixed `suite` of `mutation` or
`security`. They return a `receipt` JSON envelope with the qualification artifact
ID/digest and exact run/attempt. The publisher receives `prerelease_receipt`,
`mutation_receipt` and `security_receipt`, and verifies their dependency chain back
to the original dev record. It requires exactly one successful mutation receipt
and one successful security receipt; a receipt for one suite cannot stand in for
the other, even if both have the same source and artifact identity.

Same-run prerelease/deep evidence is validated against successful prerequisite
jobs in the exact current attempt; demanding overall success of the still-running
weekly workflow would create a deadlock. Cross-run receipt selection additionally
requires the whole producing attempt to have completed successfully.

## Publication and provenance

Build provenance must identify the trusted producer and exact source. Merely
attesting a downloaded package at publication time must not be presented as proof
that the publishing job built it. The current release-kit consumers expect the
release-kit workflow and a tag source ref; moving production to a nightly builder
requires a deliberate consumer verification update. Keep both the producer
attestation and qualification/publication evidence with the immutable digest.

The publisher must verify the original producer, not just that an attestation is
associated with this repository. Exact attestation action/consumer changes are a
cutover prerequisite, not a claim made by the prototype producer.

Preserve `SHA256SUMS` for the explicit set of native files being published. It may
be generated from the verified manifest without rebuilding/repacking those files;
its entries must exclude test-only archives unless a separately named test-artifact
channel is deliberately supported. Verify the checksum file and every published
entry before making a release public. Do not wildcard-upload the complete bundle.

For Pages, download the existing candidate, verify the full payload, upload those
unchanged files as the Pages artifact in the publication run, and deploy. Packaging
for transport can change the outer archive digest; individual application file
hashes must stay fixed. Post-deployment verification uses the candidate source SHA,
not the current scheduled workflow SHA. No build or runtime-config rewrite occurs
after qualification.

Serialize weekly qualification separately from changing main CI. If a shared
prerelease deployment is used, hold its concurrency group for the full qualification
and publication operation. Keep manual and scheduled release paths in the same
group. A new main push must not cancel a pinned release run.

## Required implementation verification

Exercise these cases before enabling production promotion:

- A later source commit and an earlier run finishing late cannot swap the candidate.
- PR/fork/manual-source evidence cannot impersonate successful main CI.
- A rerun with a different attempt cannot reuse stale green evidence.
- Expired/missing artifacts, absent target archives, extra test-only binaries,
  manifest tampering, bad checksums, unsafe archive paths and wrong source fail.
- Reusable-workflow caller identity is handled correctly.
- A failed, cancelled, skipped or incomplete required check prevents a receipt.
- Policy changes invalidate incompatible old receipts; scanner errors are not clean.
- No build command runs in the publication lane.
- Pages repackaging preserves payload hashes and live verification uses candidate SHA.
- Tags, Cargo versions and attestations bind to the selected source, not current main.
- Old automatic publishers cannot publish outside this qualification path.
- Repeating a partially successful publication is idempotent and retains candidate ID.

## References

- [GitHub artifact transfer and digest validation](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Current release kit contract](../../operators/release-kit.md)
