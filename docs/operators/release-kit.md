# Release kit

A `v*` tag the owner pushes, on a commit `main` holds and named for the
workspace version, publishes a GitHub release of prebuilt Linux binaries, so a
lane that runs `opensesame` does not have to build the workspace
([ADR 0212](../adr/0212-release-kit-binaries.md)). The workflow is
[`.github/workflows/release-kit.yml`](../../.github/workflows/release-kit.yml);
the archives are made by
[`scripts/release/kit-archive.sh`](../../scripts/release/kit-archive.sh).

## What is in a release

`<target>` is `x86_64-unknown-linux-gnu` or `aarch64-unknown-linux-gnu`.

| File | Holds |
|---|---|
| `opensesame-kit_<tag>_<target>.tar.gz` | One directory of the same name: `opensesame` and `opensesame-surrogate-proxy`, built with the shipped features; `opensesame-env-parse.mjs`, the env-spec bridge bundled with `@env-spec/parser` into one file; `LICENSE` |
| `opensesame-surrogate-proxy-TEST-upstream-override_<tag>_<target>.tar.gz` | The plugin's **test build** (`--features upstream-override`), under that name, and `LICENSE`. It can be aimed at a stand-in for the provider with `OPENSESAME_SURROGATE_TEST_UPSTREAM` and prints `TEST BUILD` on stderr. For test lanes only: never give it a real token |
| `opensesame-env-parse.mjs` | The bundled bridge on its own, the same bytes as in every kit |
| `SHA256SUMS` | The sha256 of every file above, and an attestation of its own |
| `release-files.sigstore.json` | The signed Sigstore provenance bundle covering every file named by `SHA256SUMS` |
| `SHA256SUMS.sigstore.json` | The signed Sigstore provenance bundle covering `SHA256SUMS` |

The shipped plugin and `opensesame` do not contain the test build's override at
all; the archive script refuses to pack them if they do, and refuses a test
build that does not.

## Verify a download

```bash
tag=v0.1.0 target=x86_64-unknown-linux-gnu
gh release download "$tag" --repo Tyler-R-Kendrick/OpenSesame \
  --pattern SHA256SUMS --pattern '*.sigstore.json' \
  --pattern "opensesame-kit_${tag}_${target}.tar.gz"
gh attestation verify SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --repo Tyler-R-Kendrick/OpenSesame \
  --signer-workflow Tyler-R-Kendrick/OpenSesame/.github/workflows/release-kit.yml \
  --source-ref refs/tags/$tag
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify "opensesame-kit_${tag}_${target}.tar.gz" \
  --bundle release-files.sigstore.json \
  --repo Tyler-R-Kendrick/OpenSesame \
  --signer-workflow Tyler-R-Kendrick/OpenSesame/.github/workflows/release-kit.yml \
  --source-ref refs/tags/$tag
```

`sha256sum --check` proves the file is the one the release lists.

`gh attestation verify` with those three flags proves that a run of
`.github/workflows/release-kit.yml` in this repository, started by a push of
`refs/tags/<tag>`, signed a provenance statement whose subject is this file's
digest, and the statement names the commit and the run. Without
`--signer-workflow` and `--source-ref` it proves only that some workflow of the
repository attested the file: a run of an edited copy of the workflow on a
branch would pass. Add `--source-digest <commit sha>` to pin the commit as well.
The files named by `SHA256SUMS` are subjects of `release-files.sigstore.json`;
`SHA256SUMS` is the subject of its separate bundle. Verify the manifest before
trusting its lines. These are the action's original signed bundles, also uploaded
to GitHub's attestation service; omitting `--bundle` retrieves them from that
service. The bundles do not list their own hashes in `SHA256SUMS`.

Publishing the bundles as release assets also makes the signatures discoverable
by OpenSSF Scorecard's Signed-Releases check. A workflow change alone does not
change that check: it examines published releases. It does not verify signatures,
so use the commands above to verify the downloaded bytes and signer.

It does not prove that the commit was reviewed, that the source is free of
defects, or that the binaries rebuild bit for bit. The workflow checks that the
tag names the workspace version and a commit `main` holds; an attestation says
the workflow ran, and a run of a workflow edited at the tagged commit would have
checked what it was told. What keeps anyone but the owner from creating such a
tag, once the owner has applied it, is the tag ruleset in
[Cut a release](#cut-a-release).

The archives are reproducible: entries sorted, every mtime the tagged commit's
time, owner and group 0, fixed modes and `gzip -n`. Packing the same binaries
again gives the same bytes; the binaries themselves are built with `--locked`
on Rust 1.88.0 and are not claimed to rebuild bit for bit. The build remaps the
checkout and cargo home in debug info and panic messages, except the
compiled-in checkout fallback of the bridge lookup (`CARGO_MANIFEST_DIR`, which
the compiler expands before the remap): a release binary still carries the path
it was built from, `/home/runner/work/…`, and uses it only when nothing sits
beside it and `OPENSESAME_ENV_PARSE` is unset (ADR 0212).

## Use it in a lane

Pin digests, not tags: the archive's line from `SHA256SUMS`, and the plugin's
own sha256 for `plugins install`.

```bash
echo "<64 hex>  opensesame-kit_${tag}_${target}.tar.gz" | sha256sum --check
tar -xzf "opensesame-kit_${tag}_${target}.tar.gz"
kit="$PWD/opensesame-kit_${tag}_${target}"

# The bridge sits beside the binary; opensesame finds it there.
export OPENSESAME_NODE="$(readlink -f "$(command -v node)")"
"$kit/opensesame" dev --schema .env.schema check
```

- **`node`.** The bridge needs Node 22 or later. `opensesame` runs a `node`
  only from a `PATH` directory nobody else could write; a hosted CI image keeps
  its `node` where anyone can, so name it with `OPENSESAME_NODE`
  ([proxied-run quickstart](proxied-run-quickstart.md)).
- **The bridge.** Leave `OPENSESAME_ENV_PARSE` unset and `opensesame` runs the
  `opensesame-env-parse.mjs` in its own directory (after symlinks, so a link to
  `$kit/opensesame` from elsewhere still finds it). That file and the directory
  it is in must be owned by root or you and not writable by others (a group may
  write only if it is root's or one of yours); one that is not is refused with
  the reason, not skipped. `OPENSESAME_ENV_PARSE`, when set, wins. With no
  bridge beside the binary and no `OPENSESAME_ENV_PARSE`, the binary falls back
  to the checkout path it was built from (`/home/runner/work/…` for a release),
  held to the same rule, so a file another user planted there is refused; with
  no file there either, the run stops and says where it looked. The check is by
  path: it covers the file, the directory it is in and the one a link resolves
  into, not the directories above them, and `node` opens the file a moment after
  it was checked. Put the kit where only you or root can write the whole way
  down, as you would a `node` on `PATH`. A kit unpacked into a shared directory
  such as Debian's `/usr/local/bin` (`root:staff`, group-writable) is refused for
  a user who is not in that group; the message names the group, and the fix is
  a directory of your own or the group. On Windows the bridge is only checked to
  be a regular file; the kit is Linux only.
- **The plugin.** Install the shipped plugin, or in a test lane the test build,
  by its own digest:

  ```bash
  opensesame plugins install surrogate-proxy \
    --from "$kit/opensesame-surrogate-proxy" \
    --sha256 "$(sha256sum "$kit/opensesame-surrogate-proxy" | cut -d' ' -f1)" \
    --version "${tag#v}"
  ```

  For the test build, unpack its archive and pass
  `opensesame-surrogate-proxy-TEST-upstream-override` to `--from`; the
  installed file takes the plugin's own name. Pin the digest your lane recorded,
  rather than one computed from the file in hand, once you have it.

## Cut a release

1. Set the workspace version (`[workspace.package] version` in `Cargo.toml`);
   the release refuses a tag that is not `v<that version>` or
   `v<that version>-<suffix>`. A suffix makes a prerelease.
2. Tag a commit that `main` already holds and push the tag. The first job,
   `tag check` (`scripts/release/tag-check.sh`), refuses any other tag before a
   build minute is spent; every other job needs it. An annotated tag is fine:
   the check peels `GITHUB_SHA`, which can be the tag object, to its commit.
3. The run builds both targets, checks that the unpacked kit parses
   `tests/fixtures/demo.env.schema` with its own bridge (and refuses one made
   world-writable), writes `SHA256SUMS`, attests every file and the sums, then
   creates the release as a draft at the built commit and publishes it only
   while the tag still names that commit. A failed publish leaves the draft:
   delete it and re-run the job.

**Actions › Release kit › Run workflow** with a label such as
`v0.0.0-dryrun` is a dry run of the selected commit: the files are left as
artifacts of the run, and nothing is attested or released.

### What the repository owner applies once

The checks in the workflow file are not enough on their own: whoever can push a
tag can run an edited copy of the file at the tagged commit. The ruleset below
is what stops that, and until the owner applies it nothing does; the other two
settings add friction and tamper resistance.

- **A `v*` tag ruleset.** `ops/github/release-tags.json` restricts creating,
  updating and deleting tags matching `v*` to repository admins: the admin role
  is its one bypass actor, because the owner has to be able to cut the release
  (the default-branch ruleset beside it has none). It also stops an edited copy
  dispatched from a branch from creating a tag, which `gh release create
  --verify-tag` would need. Without it, any collaborator who can push a tag can
  run an edited copy of this workflow, and its attestation and release would pass
  a check that names only the repository. Run
  `node ops/github/governance.mjs --dry-run` first (it writes nothing), then
  `--apply`, then `--verify`; `--verify` fails while the ruleset is missing or
  differs, and prints its id once it is in place. If `--apply` is answered with a
  422 for the bypass actor (the `RepositoryRole` with id 5, the admin role, may
  not be accepted on a personal repository), change the actor in
  `release-tags.json` to `{ "actor_id": <your user id>, "actor_type": "User",
  "bypass_mode": "always" }` and run it again. `--apply` writes this ruleset last,
  so a refusal does not skip the auto-merge and Pages steps, and reports it at the
  end.
- **A `release` environment** (Settings › Environments › release): add a
  required reviewer and limit deployments to the tag pattern `v*`. The
  `publish` job names it, so a release waits for approval. That is an approval
  step, not a boundary: a copy of the workflow without `environment:` gets
  the job's token without asking. Until you configure it the name is only a
  label and the job runs unattended. `governance.mjs` does not manage this
  environment. The files `publish` uses are kept 35 days, longer than an approval
  can wait.
- **Immutable releases** (Settings › General), optional: once a release is
  published, its assets and its tag cannot be replaced by a later run of an
  edited workflow.

Before it creates anything, `publish` runs `gh attestation verify` on every file
and on `SHA256SUMS` using the exact bundles it will publish and the flags in
[Verify a download](#verify-a-download),
and `kit-archive.sh sums` refuses to write `SHA256SUMS` unless the bridge on its
own is the one inside every kit.

## Not in the kit

- macOS and Windows: no job builds or runs the surrogate-proxy plugin there
  yet, and the proxied run is Linux only.
- Signatures beyond the provenance attestation.
