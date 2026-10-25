# scripts/release

Release and merge-gate tooling run from a terminal or CI.

| File | Role |
|------|------|
| `check-pr-signatures.mjs` | Fails a PR whose commits are not GitHub-verified (`scripts/lib/pr-signatures.mjs`) |
| `land-signed-stack.mjs` | Replays a local branch stack as GitHub-verified commits |
| `deploy-pages.sh`, `pages-release.mjs` | Pages publish and release marker |
| `pin-connect-services.mjs`, `pin-marketplace.mjs` | Pin generated service and marketplace digests |
| `kit-archive.sh` | The release kit's reproducible archives and `SHA256SUMS`, run by `.github/workflows/release-kit.yml` ([docs/operators/release-kit.md](../../docs/operators/release-kit.md)) |
| `publish-packages.mjs` | Validates exact workspace package names from `NPM_PACKAGES` and publishes with shell-free argv; used only by the main-branch npm workflow |
| `tag-check.sh` | What a `v*` tag must be before the release kit builds anything: the workspace version, a commit `main` holds, the commit an annotated tag peels to (`commit`, `verify`); the workflow's first job ([docs/operators/release-kit.md](../../docs/operators/release-kit.md)) |

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

Container publication uses `GHCR_PUBLISH_TOKEN` from the `container-release`
environment. Configure that environment for branch `main` and tags `v*`, and
remove this source repository's automatic Actions token write access to the
official package. Keep the separate credential in the environment only; an
editable workflow cannot enforce a package ACL by itself. Until those controls
are configured, publication is intentionally unavailable.
