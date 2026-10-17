# Release kit

Every `v*` tag publishes a GitHub release of prebuilt Linux binaries, so a lane
that runs `opensesame` does not have to build the workspace
([ADR 0207](../adr/0207-release-kit-binaries.md)). The workflow is
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
| `SHA256SUMS` | The sha256 of every file above |

The shipped plugin and `opensesame` do not contain the test build's override at
all; the archive script refuses to pack them if they do, and refuses a test
build that does not.

## Verify a download

```bash
tag=v0.1.0 target=x86_64-unknown-linux-gnu
gh release download "$tag" --repo Tyler-R-Kendrick/OpenSesame \
  --pattern SHA256SUMS --pattern "opensesame-kit_${tag}_${target}.tar.gz"
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify "opensesame-kit_${tag}_${target}.tar.gz" \
  --repo Tyler-R-Kendrick/OpenSesame
```

`sha256sum --check` proves the file is the one the release lists.
`gh attestation verify` proves the release workflow of this repository built it,
from which commit and in which run; every file `SHA256SUMS` names has its own
attestation.

The archives are reproducible: entries sorted, every mtime the tagged commit's
time, owner and group 0, fixed modes and `gzip -n`. Packing the same binaries
again gives the same bytes. The binaries are built with `--locked` on Rust
1.88.0, with the checkout and cargo home paths remapped.

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
  `$kit/opensesame` from elsewhere still finds it). That file and its directory
  must be owned by root or you and not writable by others; one that is not is
  refused with the reason, not skipped. `OPENSESAME_ENV_PARSE`, when set, wins.
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
2. Tag a commit that `main` already holds and push the tag. A tag on any other
   commit stops before anything is attested or published.
3. The run builds both targets, checks that the unpacked kit parses
   `tests/fixtures/demo.env.schema` with its own bridge (and refuses one made
   world-writable), writes `SHA256SUMS`, attests, then creates the release as a
   draft at the built commit and publishes it only while the tag still names
   that commit. A failed publish leaves the draft: delete it and re-run the job.

**Actions › Release kit › Run workflow** with a label such as
`v0.0.0-dryrun` is a dry run of the selected commit: the files are left as
artifacts of the run, and nothing is attested or released.

## Not in the kit

- macOS and Windows: no job builds or runs the surrogate-proxy plugin there
  yet, and the proxied run is Linux only.
- Signatures beyond the provenance attestation.
