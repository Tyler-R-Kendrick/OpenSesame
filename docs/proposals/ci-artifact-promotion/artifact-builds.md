# Candidate builds and artifact qualification

**Status: proposal; nothing in this directory activates a workflow or publishes
an application.** The inspected baseline is
`aad2c85b4b567fd632d0e409d53d17bb66e8fba4`. The inert
[`workflows/candidate-build.yml`](workflows/candidate-build.yml) is a concrete
producer design, not a claim that the complete pipeline has run successfully.

## Build a selected snapshot once

Trunk remains the integration branch. Fast CI continues to report on changes;
the nightly controller selects an exact successful `push`-to-`main` CI attempt
and materializes that snapshot as a candidate. The producer has
`workflow_call` and manual `workflow_dispatch` entry points, **no independent
schedule and no push or pull-request trigger**. The two-platform native matrix
therefore runs for selected snapshots, not every incremental task commit.

The call requires three strings:

| Input | Required meaning |
| --- | --- |
| `source_sha` | Full lowercase 40-hex commit already contained in `refs/remotes/origin/main` |
| `source_ci_run_id` | A run of `.github/workflows/ci.yml` for that SHA, in this repository, with event `push` and branch `main` |
| `source_ci_run_attempt` | The exact completed successful attempt, not the latest attempt assumed from a run ID |

The producer checks this evidence before building. Every build job checks out
the resolved SHA. It reads the prospective **stable** version from
`[workspace.package].version` in that snapshot's `Cargo.toml`; this first design
requires an ordinary `major.minor.patch` version. It does not create a Git tag.

Choose the eventual stable version before building, such as `0.2.0`. An artifact
may qualify first as dev and then prerelease while its immutable package still
says `0.2.0`. Channel and approval state belong to the release record, not a
later rewrite of the executable, tar directory, or PWA. Repacking an archive
from an RC name to a stable name changes its digest. A source or version fix
creates a new candidate and needs new qualification.

## Output inventory and identity

The candidate ID is `<source-sha>-<producer-run-id>-<producer-attempt>`.
Intermediate Actions artifacts include this ID and their purpose. The final
artifact is `<candidate-id>-complete` and contains exactly these six payloads,
plus `candidate.json`:

| Payload path | Role | Target |
| --- | --- | --- |
| `production/opensesame-pages_v<version>.tar.gz` | Production | Hosted Pages PWA |
| `production/opensesame-env-parse.mjs` | Production | Node 22 bridge |
| `production/opensesame-kit_v<version>_x86_64-unknown-linux-gnu.tar.gz` | Production | Linux x86_64 |
| `production/opensesame-kit_v<version>_aarch64-unknown-linux-gnu.tar.gz` | Production | Linux aarch64 |
| `test-only/opensesame-surrogate-proxy-TEST-upstream-override_v<version>_x86_64-unknown-linux-gnu.tar.gz` | Test only | Linux x86_64 |
| `test-only/opensesame-surrogate-proxy-TEST-upstream-override_v<version>_aarch64-unknown-linux-gnu.tar.gz` | Test only | Linux aarch64 |

The proxy's `upstream-override` feature allows an artificial upstream. It must
never replace the shipped plugin or receive real provider tokens. The native
builder copies each binary immediately after its build: both feature variants
otherwise write the same filename under `target/release`. Separate upload names
and `production/` versus `test-only/` directories preserve this distinction.
Consumers select explicit production manifest entries; they must not publish
the entire complete-bundle directory with a wildcard.

The final manifest step requires all expected files and rejects missing or
unexpected files and symbolic links. It checks archive membership, checks the
test-only marker is absent from shipped binaries and present in test proxies,
and checks that every kit carries the exact standalone bridge bytes. The Pages
archive must contain its entry point, fallback, runtime config, security
profile, and release marker for the selected SHA. SHA-256 and byte size are
then recorded for every complete payload, including test-only files.

`candidate.json` has this versioned contract; the complete template emits real
values, not placeholders:

```text
format: "opensesame-candidate"
schema_version: 1
candidate_id: string
source_sha: full commit SHA
version: prospective stable Cargo version
producer:
  run_id: string
  run_attempt: string
  workflow_ref: actual GITHUB_WORKFLOW_REF
  workflow_sha: actual GITHUB_WORKFLOW_SHA
  recipe_path: ".github/workflows/candidate-build.yml"
source_ci:
  run_id: string
  run_attempt: string
payloads:
  - path: relative payload path
    role: "production" or "test-only"
    target: "pages", "node22", or Rust target triple
    sha256: 64 lowercase hex
    size: integer bytes
```

The builder returns `candidate_id`, `source_sha`, `run_id`, `run_attempt`,
`artifact_id`, `artifact_digest`, and `payload_digest` to its caller. Here
`payload_digest` means SHA-256 of the exact canonical `candidate.json` bytes
(sorted compact JSON followed by one newline). `artifact_digest` is the
separate Actions upload digest. They are not interchangeable. The artifact ID
and upload digest belong in the controller's external candidate envelope;
embedding them inside the artifact would introduce a self-reference.

The template's final manifest hashes the bytes that arrived in that job. It
does not independently prove they equal each original intermediate upload.
The download action's digest comparison must not be treated as a hard gate if
a mismatch only warns. Before activation, the checked-download/provenance
contract must cover **each intermediate artifact** as well as the complete
bundle: retain producer-upload IDs and digests outside the downloaded content,
verify them with a failing comparison, and authenticate the producing run/job.
The same requirement applies to cross-run consumers. This remains planned;
this unsigned template makes no signed build-provenance guarantee.

A reusable workflow shares its caller's run ID and attempt. Its Actions run
may have path `.github/workflows/dev-nightly.yml`, not `candidate-build.yml`.
The recorded workflow context must be verified as observed, against the
allowlisted caller and producer recipe revision. `recipe_path` is descriptive
metadata, not a signature or proof that this file executed.

### Complete-candidate reuse: planned controller interface

Before invoking the builder, the controller may find an already materialized
candidate. **The selector/downloader and trust check are planned interfaces;
this producer template contains no helper that pretends to implement them.**
Their input is the desired source SHA, the required artifact/profile inventory,
and the approved producer/caller policy revision. Their result is either a
complete verified candidate envelope with the seven fields above, or a cache
miss that invokes this build workflow.

A valid hit requires a nonexpired immutable artifact, expected repository and
successful exact producer attempt, an allowed workflow/caller identity,
matching manifest identity and approved build profile, all six exact payloads,
and recomputed manifest and file hashes. Reuse must preserve the original
producer identity. A newer consumer must not overwrite that record with its
own run ID. Validation under a changed policy can add new evidence to the same
bytes if the build remains compatible; changed build inputs/profile require a
new materialization. The controller also retains the selected source-CI
evidence rather than substituting an unrelated successful run.

An expired, incomplete, or untrusted artifact is a miss, not permission to
substitute the latest branch build. Rebuilding creates a new candidate ID and
restarts qualification. The prototype intentionally does not implement partial
reuse of an arbitrary fast-CI Pages output. That optimization needs equivalence
of source, dependency lockfiles, build recipe, Vite inputs, and all post-build
stamps, followed by the same whole-artifact verification.

## Authoritative production recipes

### Pages

The recipe follows `.github/workflows/deploy-pages.yml`: install the frozen
pnpm lockfile, build through Turbo so workspace dependencies are built first,
copy `index.html` to `404.html`, write permitted runtime configuration, and
stamp the release SHA. The proposed producer also includes `.nojekyll` before
freezing and packages the entire output, preserving hidden build files inside
the tar. It forces the build instead of accepting unverified cached task
outputs, and passes the explicitly declared Vite/profile inputs.

This variant is fixed to `/OpenSesame/`, `shared_origin_demo`, and
`https://tyler-r-kendrick.github.io`. No deployment environment secrets are
attached. Identity, Host, daemon, and serverless Connect URLs remain forbidden
runtime stamps by `apps/pages/scripts/write-runtime-config.mjs`. All permitted
stamps happen **before** hashing; a consumer cannot stamp a new configuration
and still claim to have tested/promoted identical bytes.

The current `scripts/lib/pages-release.mjs` marker hashes only `index.html`
and `os-runtime-config.json`. It remains useful for its existing live probe,
but is not a whole-site inventory. The candidate archive's digest covers all
served files; consumers need its manifest verification as well as the live
probe. A live marker by itself does not verify every fetched JavaScript asset.

### Native kits and bridge

The recipe follows `.github/workflows/release-kit.yml` and
`scripts/release/kit-archive.sh`: Rust 1.88.0, `--locked --release`, native
Ubuntu x86_64/aarch64 runners, explicit shipped and test proxy feature sets,
the bundled env-spec bridge, and reproducible archive packaging using the
source commit timestamp. Reproducible packaging does not claim independently
rebuilt binaries are bit-for-bit identical.

The template runs the existing archived-kit smoke behavior on each target:
invoke the unpacked CLI with its adjacent bundled parser and reject a bridge
made writable by others. The checkout parser is moved away for that probe.
`OPENSESAME_NODE` points to the runner's resolved Node executable, as required
by the existing bridge trust checks. A debug Cargo build is not accepted as a
replacement for these release artifacts.

## Existing tests that can consume the candidate

The simplest browser consumers need no source build:

| Existing command | Artifact integration |
| --- | --- |
| `pnpm --filter @opensesame/pages verify:static` | Set absolute `PAGES_VERIFY_DIST`; set production `PAGES_ORIGIN` and `VITE_BASE` |
| `pnpm --filter @opensesame/pages verify:device-identity` | Same existing dist/origin/base hooks |
| `pnpm --filter @opensesame/pages verify:cli-public-site` | Same hooks; the script explicitly does not rebuild |
| `pnpm --filter @opensesame/pages verify:push-worker` | Currently reads `apps/pages/dist`; extract there unchanged or add a dist-path option |
| `pnpm --filter @opensesame/pages verify:sw-dirty-edit` | Same fixed-dist assumption; its scenario serves a worker override without rewriting the stored candidate |
| `pnpm --filter @opensesame/pages verify:relay-join-live` | Set `OPENSESAME_RELAY_BIN` to the unpacked candidate CLI; otherwise it can fall back to a debug binary or `cargo run` |

The production-origin browser harness serves the candidate's files through
Playwright routing. It tests the production origin assumptions without
publishing publicly. Its normal contexts block service workers, so the explicit
worker/update tests retain their own purpose. Browser runners still need test
dependencies and an installed compatible browser; downloading the application
artifact does not install the test harness.

The TypeScript native process/failure tests under `scripts/test/2password-*`
accept `OPENSESAME_NATIVE_BINARY`. The overall parity runner currently builds
its own prerequisites and replaces that path. Calling the overall runner is
therefore **not** currently a no-rebuild artifact qualification operation.

## Source and test-only variants remain separate

Several existing checks intentionally require bytes unlike the production PWA:

| Existing family | Required distinct build or adaptation |
| --- | --- |
| Fresh-vault onboarding | `verify:fresh-vault-login` rebuilds with `VITE_PWA_OFFER_PASSWORDS_ONBOARDING=1`; `VERIFY_SKIP_BUILD=1` only works with that prebuilt variant, currently in `dist` |
| Push | `build:push-verify` produces `dist-push-verify`, stamped for loopback port 41877 |
| Identity / secret backends | Their own `dist-identity-verify` and `dist-secret-backends-verify` plus loopback security profiles |
| AI connections | `dist-ai-connections-verify`, loopback profile and `OPENSESAME_AI_COMPLETION_VERIFY=1` |
| Tailnet browser | `dist-tailscale-browser-verify`, separate loopback profile |
| Dedicated live peering | `dist-live-dedicated`, `dedicated_origin`, header-security stamp, `https://opensesame.example.test` |
| Capability/tutorial profiles | Separate selected/hardened capability builds; tutorial profile reuse supports `VERIFY_SKIP_BUILD=1` only when those directories exist |

Retain these as source/variant checks until separate test-artifact producers
are implemented. They must not mutate the production candidate directory or
be reported as tests of identical production bytes. Existing source tests,
coverage, fuzzing, and mutation remain evidence for a source/test snapshot.
Their instrumented compilations are permitted test work, not new production
artifacts to deploy.

In particular, `scripts/test/proxied-run-test.sh` builds the test proxy and runs
Cargo tests. Its Rust harness uses compile-time
`env!("CARGO_BIN_EXE_opensesame")`; a runtime binary path does not substitute
the release CLI. Fully eliminating later compilation requires producing test
executables and changing that harness, including fixture/path assumptions.
This first proposal does not claim that work is complete.

## Qualification channels and hosted environments

`integration`, `dev`, `prerelease`, and `release` describe qualification/channel
states. They do not introduce an integration Git branch. They also do not, by
themselves, provision four hosted PWA instances.

`apps/pages/scripts/security-profile.mjs` and `stamped-build.mjs` bake the
canonical origin/profile into the bundle; Vite also bakes the base path. A
different origin or base is a different build variant. Four environment names
do not create four GitHub Pages sites, and four paths on one origin do not
isolate browser-origin storage. This proposal keeps one production-targeted
artifact, qualifies it without publishing, and promotes that artifact to the
existing hosted destination only through the future publisher.

If four isolated preview origins become a requirement, specify their hosting,
storage separation, origin-bound identity behavior, and variant-specific
qualification separately. Do not rewrite the frozen bundle at promotion and
claim byte identity.

## Publication and signing migration

The current release kit requires a `v*` tag matching the workspace version on
a commit main already contains. It checks the tag again before draft creation
and publication, verifies provenance from `release-kit.yml` at
`refs/tags/<tag>`, and retains release files for 35 days. The proposed candidate
builder also retains its final bundle for 35 days, but **does not attest or
publish it**. Hashes and recorded run metadata are not a signed release claim.

Before activating publication, explicitly redesign its provenance expectation:
verify the original builder/caller and source digest, retain that build
evidence, and attach promotion evidence for the unchanged payloads. An
attestation emitted by a later publisher must not imply it compiled artifacts
that were merely downloaded. Consumers currently requiring the old signer and
tag source ref need a deliberate migration, not a weaker repository-only check.

Preserve the existing tag/version checks, tag immutability checks, production
versus test-only distinction, release-environment policy, and draft-before-
publish behavior. Rulesets and environment protection are external settings;
this document does not change them. Publishing a candidate must also retire or
constrain the independent `scripts/release/deploy-pages.sh` rebuild/push path
if the new policy is meant to govern every production deployment.

## Scope and activation work

This producer covers the existing hosted PWA plus two Linux kits. It does not
claim release artifacts for the browser extension, signed IWA, macOS, Windows,
mobile apps, npm packages, container images, or every workspace service.
Those need explicit builders, artifact contracts, and tests before a release
can claim coverage. The bridge is a bundled Node file, not an npm publication.

Activation would change `.github/workflows/ci.yml`, `deploy-pages.yml`, and
`release-kit.yml`, add the controller/producer/qualification workflows, and
update `scripts/lib/ci-release-kit.test.mjs`, `release-tag-check.test.mjs`,
`release-contract.test.mjs`, relevant gate routing, and `AGENTS.md`. Existing
workflow-shape tests pin current behavior; do not disable them to make a new
pipeline appear green. First validate the actual producer, digest rejection,
cross-run download, retention failure, exact binary/PWA consumers, and
publication contract in an isolated run. This proposal creates none of those
external deployments or settings.
