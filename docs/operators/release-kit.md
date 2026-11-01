# Release kit and artifact promotion

OpenSesame integrates changes on `main`, builds selected snapshots into immutable
candidates, and publishes the same qualified bytes on the weekly release train.
[`candidate-build.yml`](../../.github/workflows/candidate-build.yml) produces the
artifacts; [`release-publish.yml`](../../.github/workflows/release-publish.yml)
promotes them after the dev, prerelease, mutation, and security gates pass.
A tag push no longer starts a production build or a deployment. The old
`release-kit.yml` and `deploy-pages.yml` entry points fail with migration guidance.

## What is in a release

The prospective stable version comes from `[workspace.package].version` in the
selected source commit's `Cargo.toml`. Choose it **before** building. Channel
qualification does not rewrite versions or repack archives. `<tag>` is
`v<major.minor.patch>`; `<target>` is `x86_64-unknown-linux-gnu` or
`aarch64-unknown-linux-gnu`.

| Asset | Meaning |
| --- | --- |
| `opensesame-kit_<tag>_<target>.tar.gz` (two) | One directory of the same name containing `opensesame`, the shipped `opensesame-surrogate-proxy`, the bundled `opensesame-env-parse.mjs`, and `LICENSE` |
| `opensesame-surrogate-proxy-TEST-upstream-override_<tag>_<target>.tar.gz` (two) | Explicitly labeled test proxy and `LICENSE`; permits a stand-in upstream. Never provide real provider tokens to this build |
| `opensesame-env-parse.mjs` | The exact bridge contained in both production kits |
| `opensesame-pages_<tag>.tar.gz` | The entire production Pages site, including runtime config, security profile, release marker, and worker/assets |
| `candidate.json` | Canonical source, version, original builder run/attempt and workflow revision, source CI, and six-file hash/size inventory |
| `build-provenance.sigstore.json` | The original builder's signed attestation bundle, preserved rather than replaced by a publisher's build claim |
| `dev-receipt.json`, `prerelease-receipt.json`, `mutation-receipt.json`, `security-receipt.json` | The exact qualification records used for this publication |
| `promotion.json` | Candidate identity, qualification envelopes, current release controller identity, and policy digest |
| `SHA256SUMS` | Every other release asset's SHA-256, in a fixed explicit inventory; signed separately as promotion evidence |

There are fourteen release assets. `SHA256SUMS` cannot contain its own digest;
its promotion attestation supplies that binding. Production archives, separately
named test downloads, and `candidate.json` are immutable once staged. Test
behavior markers must be absent from shipped executables and present in the
test proxy. The manifest gate also checks that each kit contains the exact
standalone bridge bytes.

## Verify a download

Download the checksum file, canonical candidate, promotion record, and the kit
needed by the lane. The CLI must support `gh attestation verify` and its signer
and source-digest options.

```bash
tag=v0.2.0
target=x86_64-unknown-linux-gnu
repo=OpenSesame-Labs/OpenSesame
gh release download "$tag" --repo "$repo" \
  --pattern SHA256SUMS --pattern candidate.json --pattern promotion.json \
  --pattern "opensesame-kit_${tag}_${target}.tar.gz"

builder=$(node -p 'JSON.parse(require("fs").readFileSync("candidate.json")).producer.workflow_sha')
promoter=$(node -p 'JSON.parse(require("fs").readFileSync("promotion.json")).controller.workflow_sha')

gh attestation verify candidate.json --repo "$repo" \
  --signer-workflow "$repo/.github/workflows/candidate-build.yml" \
  --signer-digest "$builder" --source-ref refs/heads/main --source-digest "$builder" \
  --predicate-type https://opensesame.dev/attestations/candidate-build/v1 \
  --deny-self-hosted-runners

gh attestation verify SHA256SUMS --repo "$repo" \
  --signer-workflow "$repo/.github/workflows/release-publish.yml" \
  --signer-digest "$promoter" --source-ref refs/heads/main --source-digest "$promoter" \
  --predicate-type https://opensesame.dev/attestations/release-promotion/v1 \
  --deny-self-hosted-runners

sha256sum --check --strict --ignore-missing SHA256SUMS
```

The first signature authenticates the original build and its canonical inventory.
The second authenticates promotion of the fixed download set after qualification.
The checksum check then binds the files actually downloaded, including
`candidate.json` and `promotion.json`, to the signed publication inventory.
Inspect the candidate's `version` and `source_sha` against the intended release;
record the desired archive digest in downstream configuration.

A selected source SHA can be older than the controller's revision. The signed
candidate explicitly distinguishes `source_sha` from `producer.workflow_sha`.
The latter identifies the trusted workflow code; it is the source digest in
GitHub's signing certificate. A reusable workflow's attestation signer is
`candidate-build.yml`, even when the Actions run API reports `dev-nightly.yml`
as the top-level workflow. The custom build predicate binds the selected source,
source-CI attempt, original producer attempt, and all payloads. The publisher
signs a **promotion** predicate and does not claim to have compiled the binaries.

Do not weaken these checks to `--repo` alone. A signature from an unrelated
workflow, a branch dispatch, another workflow revision, or an unrelated producer
attempt is insufficient. `scripts/release/provenance.mjs` performs these checks
for internal consumers and compares the signed predicate with the candidate.
The preserved build bundle retains the original signed DSSE payload, signatures
and verification material. Canonical JSON serialization stabilizes its release
checksum without changing any signed bytes or creating a new build signature.
The preserved build bundle supports offline verification with `--bundle`; an
online verification also checks GitHub's current repository identity.

Releases produced before this migration retain their original verification
contract: `--signer-workflow
OpenSesame-Labs/OpenSesame/.github/workflows/release-kit.yml` and
`--source-ref refs/tags/<tag>`, using the default SLSA provenance predicate.
Do not treat an old release's missing candidate metadata as a new-pipeline
success; choose the verification policy belonging to the release.

The archives remain reproducible packages: sorted members, selected commit
mtime, owner/group 0, fixed modes and `gzip -n`. Repacking the same binaries
produces the same archives; independently rebuilt binaries are not claimed to
be identical. Rust 1.88.0 uses locked dependencies and path remapping, except the
compiled-in checkout fallback used by the bridge lookup (`CARGO_MANIFEST_DIR`).

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

## Release operation and recovery

1. Merge changes continuously to `main` with fast CI. Set a new stable workspace
   version before selecting a candidate that will occupy that version's tag.
2. The nightly controller captures an exact successful `push`-to-`main` CI
   attempt. It reuses a complete verified compatible candidate or invokes the
   producer. The two native architectures are built for that snapshot, not for
   every incremental commit. A manual builder dispatch still requires an exact
   main source SHA and successful source-CI run ID and attempt.
3. The original builder checks production archives, executes each kit's adjacent
   parser and writable-parser refusal, signs all six outputs plus the manifest,
   and retains the complete artifact for 35 days. Intermediate transfers verify
   immutable artifact ID/name/run binding, authenticated upload digest, and the
   downloaded ZIP digest before safe extraction. A digest mismatch fails.
4. The weekly controller selects a recent successful dev candidate, runs
   prerelease qualification, then mutation and security checks. They all bind to
   the same original candidate. Source-based mutation and instrumentation remain
   source/test evidence; they do not replace the production artifacts.
5. The staging job first waits for `release` environment approval linked to the
   immutable candidate run. The publisher revalidates all receipts and original
   provenance after every environment wait. It checks the source remains on main, the version matches
   that source, the stable version advances, and the tag is absent or already
   points to that exact source. It never force-updates a tag. If permitted by
   repository rules, it creates the missing lightweight tag.
6. It creates or resumes an owned unpublished draft, attaches the explicit asset
   set, and signs the checksum inventory as promotion evidence. The stage summary
   links the generated notes and assets and identifies the exact candidate. Pages
   depends on the approved staging job and revalidates evidence afterward. Pages
   receives the original archive's tar bytes in the hosting transport; no production
   build, stamp, origin rewrite, or archive rewrite occurs. The uploaded transport
   is downloaded and digest-checked before deployment. Every served content file
   is compared with the extracted candidate afterward; `.nojekyll` is a packaging
   control file, not a public endpoint.
7. Only after live Pages verification and a second `release` environment approval
   does the final job recheck the complete release assets and tag, then publish
   the GitHub release. Failure leaves a
   visible failed workflow and an unpublished draft. A Pages deployment that
   succeeded before a later publication failure may already be live; retrying
   promotes those same bytes again.

**Retry the complete weekly qualification attempt.** The policy rejects mixing
receipts from different release attempts or running only a failed publish job
with old qualification evidence. The original candidate can remain unchanged.
Its dev evidence must still be fresh and its original artifact available.

An unpublished draft may resume only if its ownership marker and immutable
`candidate.json` bind to the same candidate. Existing product files with identical
hashes are reused; any product collision stops publication. Freshly verified
qualification can replace only the fixed staging evidence names: the four
receipts, `promotion.json`, `build-provenance.sigstore.json`, and `SHA256SUMS`.
This draft-only exception allows a new complete attempt to supersede earlier
staging evidence. Old receipts remain in their original Actions artifacts.
No published release asset is overwritten, deleted, or appended. Unknown assets,
duplicate names, missing published files, or a draft belonging to another
candidate fail instead of being silently cleaned up.

Expired or incomplete candidates are not reconstructed under the same identity.
Build a new candidate and repeat qualification. A version already published for
different source or payload bytes is a collision even when some files happen
to match. An already published candidate, or a new envelope with the same source,
version, and all six identical payloads, can be an explicit no-op only after the
complete published assets, original signatures, and live Pages bytes verify.
The existing release retains its original candidate and provenance; no new
identity is substituted into published files.

### Repository settings required for operation

These workflows do not change repository settings. Confirm them before enabling
production publication:

- **Main protection.** Keep the verified-signature and required-check rules on
  `main`; trusted workflow revisions come from that protected branch.
- **Release environment.** Settings › Environments › release must permit
  deployments from `main`. An older `v*`-only deployment rule blocks this new
  main-based publisher. Retain any required reviewer policy. Both jobs with
  contents-write permission use this environment: staging waits before creating
  any draft or tag, and native publication waits again after Pages verification.
- **Pages environment and source.** The `github-pages` environment must permit
  `main`, and the Pages publishing source must be GitHub Actions. The PWA is
  still the existing shared-origin `/OpenSesame/` deployment, not four isolated
  hosted environments.
- **Tag policy.** Verify both `ops/github/release-tag-creation.json` and
  `ops/github/release-tags.json` are applied. The first permits owner/admin and
  the Actions integration to create `v*` tags; the second permits only the
  owner/admin to update or delete them. Never give Actions a mutation bypass.
  An authorized operator may instead create the exact tag at the verified
  source. A denied tag write stops the workflow; it never relaxes a rule.
- **Attestations.** The repository/account must support artifact attestations,
  and the reusable caller must grant the declared token scopes. A signing or
  verification failure blocks qualification; there is no unsigned fallback.
- **Retention and immutability.** Preserve the 35-day candidate/evidence retention
  and consider GitHub Immutable releases for additional protection of published
  tags/assets. Approval waits can outlast dev-evidence freshness, requiring a
  fresh qualified attempt rather than an override.

## Scope

This publisher covers the production Pages PWA, two Linux kits, the standalone
bridge, and separately labeled test proxy downloads. It does not claim to
publish npm packages, container images, browser extensions, signed IWAs, macOS,
Windows, or mobile packages. Those require their own immutable producer and
qualification contracts. This migration does not deploy four PWA origins;
origin/base/security-profile changes require a separately built and tested
variant.
