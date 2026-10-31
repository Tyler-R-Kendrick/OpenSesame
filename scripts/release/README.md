# scripts/release

Release and merge-gate tooling run from a terminal or CI.

| File | Role |
|------|------|
| `check-pr-signatures.mjs` | Fails a PR whose commits are not GitHub-verified (`scripts/lib/pr-signatures.mjs`) |
| `land-signed-stack.mjs` | Replays a local branch stack as GitHub-verified commits |
| `candidate.mjs`, `lib/candidate-*.mjs` | Select and admit immutable candidates; verify source, provenance, qualification receipts and existing publication |
| `artifact-transfer.mjs`, `archive-safe.py` | Verify immutable artifact identity and downloaded bytes before safe extraction |
| `build-manifest.py`, `collect-build.mjs`, `provenance.mjs` | Assemble the complete candidate and bind its payloads to the selected source and original build |
| `deep-tools.sh`, `deep-check.sh` | Pinned weekly mutation/security tooling and required suites; missing or incomplete evidence fails |
| `stage-release.mjs`, `publish-release.mjs`, `publish-assets.mjs`, `verify-site.mjs` | Stage exact assets, publish the qualified release and verify every served Pages file |
| `deploy-pages.sh`, `pages-release.mjs` | Retired local publisher and the build-time Pages release marker; publication now belongs to `release-weekly.yml` |
| `pin-connect-services.mjs`, `pin-marketplace.mjs` | Pin generated service and marketplace digests |
| `kit-archive.sh` | The native kit's reproducible archives, built once by `candidate-build.yml` and promoted unchanged ([release kit](../../docs/operators/release-kit.md)) |
| `publish-packages.mjs` | Preserved shell-free npm helper: validates exact workspace names from `NPM_PACKAGES`; no active publisher calls it until npm artifacts join candidate qualification |
| `tag-check.sh` | Offline tag/version/ancestry checks; the active publisher independently enforces the selected source and stable version before writes ([release kit](../../docs/operators/release-kit.md)) |

See [CI and artifact promotion](../../docs/operators/ci-promotion.md) for the
nightly and weekly controllers, artifact inventory, evidence and recovery.

## land-signed-stack

The ruleset accepts only commits GitHub itself created, which means
`createCommitOnBranch`. A session that cannot reach GraphQL leaves an unsigned
local stack. Anyone with a working `gh` login replays it with one command:

```bash
# Dry run (default): prints branches, commits, files and bytes; calls nothing.
node scripts/release/land-signed-stack.mjs \
  --repo OWNER/REPO --base main --branches b1,b2,b3

# Create b1-signed, b2-signed, b3-signed and replay every commit.
node scripts/release/land-signed-stack.mjs \
  --repo OWNER/REPO --base main --branches b1,b2,b3 --apply
```

With `--apply` each `<branch><suffix>` (default `-signed`) is created through
the REST refs API at the previous branch's new head, the first at the remote
head of `--base` (which must equal the local `--base`). Every commit is then
replayed with `expectedHeadOid` threaded from the previous mutation, and the
verification state and tree of each created commit is printed. The exit status
is non-zero if any is unverified or differs from the local tree. It never
force-pushes, deletes a branch or merges; open the PRs from the `-signed`
branches.

The mutation cannot express symlinks, submodules, executable-bit changes or
merge commits; the planner refuses them by name before anything is sent.
Planning lives in `scripts/lib/signed-replay.mjs` (pure, tested against a
throwaway repository in `signed-replay.test.mjs`).

Status: tested offline only (plan, payloads, refusals, dry run). The live
GitHub calls have not been exercised yet.

## Deferred registry publication

The npm and container workflow entry points are retired, manual-only failures.
The weekly candidate currently publishes Pages and Linux kits; it does not invoke
`publish-packages.mjs` or publish an OCI image. The shell-free npm helper remains
available for a future integration, with its exact workspace-name validation and
separate security tests intact. Reenabling either registry requires an explicit
immutable artifact inventory, qualification, provenance and promotion contract.
Calling the preserved helper directly is not a qualified release path.

Before reenabling container publication, preserve the upstream credential
boundary: use `GHCR_PUBLISH_TOKEN` only from the `container-release` environment,
configure that environment for branch `main` and release tags `v*`, and remove
this source repository's automatic Actions token write access to the official
package. An editable workflow cannot enforce the package ACL by itself. These
external controls are prerequisites for a future publisher; configuring them
does not activate the retired workflow or add OCI artifacts to this pipeline.
