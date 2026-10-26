# ADR 0212 — A release kit of native binaries, verified by digest

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR 0006](0006-env-spec-delivery-modes.md) (the env-spec
  bridge, `OPENSESAME_NODE`), [ADR 0150](0150-surrogate-credentials-at-the-last-hop.md)
  §7 (plugins installed with a sha256 pin)
- **Implementation:** `.github/workflows/release-kit.yml`,
  `scripts/release/kit-archive.sh`, `scripts/release/tag-check.sh`,
  `ops/github/release-tags.json`, `packages/env-spec-bridge/scripts/bundle.mjs`,
  `crates/env-spec/src/node_bridge/script.rs`; operator guide
  [docs/operators/release-kit.md](../operators/release-kit.md). The workflow has
  not yet run on GitHub: what it builds is checked locally and by the tests
  named below, the release itself only by its first tag.

> [ADR 0213](0213-trunk-ci-artifact-promotion.md) replaces the original tag-triggered
> rebuild/publication with nightly candidates and weekly promotion. This ADR
> continues to specify kit layout and bridge trust.

## Context

Until now OpenSesame shipped a container image (`publish-containers.yml`) and
npm packages (`publish-npm.yml`), and nothing else. A lane that needs the real
`opensesame` binary and the surrogate-proxy plugin, such as a downstream
lane's acceptance run of a proxied `dev run`, builds both from source: a Rust
toolchain, the whole workspace, several minutes and a few gigabytes per run.

Two things kept a prebuilt binary from working on another machine. The binary
found the env-spec bridge only through `OPENSESAME_ENV_PARSE` or a path
compiled in from the checkout (`packages/env-spec-bridge/bin/…`), which does
not exist where the binary was downloaded to. And the bridge is a script that
imports `@env-spec/parser`, so it needed a `node_modules` beside it.

## Decision

1. **A tag publishes a kit.** A pushed `v*` tag runs `release-kit.yml`, which
   builds on the architecture each target runs on (`x86_64-unknown-linux-gnu`
   on `ubuntu-24.04`, `aarch64-unknown-linux-gnu` on `ubuntu-24.04-arm`; no
   cross linker) and publishes a GitHub release of:
   - `opensesame-kit_<tag>_<target>.tar.gz`: `opensesame` and
     `opensesame-surrogate-proxy` built with the shipped features, and the
     bundled bridge `opensesame-env-parse.mjs` beside them;
   - `opensesame-surrogate-proxy-TEST-upstream-override_<tag>_<target>.tar.gz`:
     the plugin built with `--features upstream-override`, the build that can
     be aimed at a stand-in upstream. It is a separate archive under a name that
     says what it is, so nobody unpacks it by accident with the shipped kit,
     and `kit-archive.sh` refuses to pack a shipped plugin or `opensesame` that
     carries the override's variable, or a test build that does not
     (`crates/surrogate-proxy/tests/shipped_build.rs` holds the shipped one to
     the same rule);
   - `opensesame-env-parse.mjs` on its own, and `SHA256SUMS` over every file.

   Run by hand the workflow is a dry run: the same builds, left as artifacts,
   nothing attested or released.
2. **A lane trusts a digest, not a name.** Packing is reproducible: the same
   binaries and bridge give the same archive bytes (entries sorted, every mtime
   the tagged commit's time (`SOURCE_DATE_EPOCH`), owner and group 0, fixed
   modes, ustar headers, `gzip -n`). The binaries themselves are built with
   `--locked` on a pinned toolchain and are not claimed to rebuild bit for bit
   (linker, glibc and C dependencies come from the runner image). Each file
   SHA256SUMS names, and SHA256SUMS itself, gets a build-provenance attestation
   (`actions/attest-build-provenance`) bound to this workflow, commit and run.
   A lane checks it with `gh attestation verify <file> --repo <owner/repo>
   --signer-workflow <owner/repo>/.github/workflows/release-kit.yml
   --source-ref refs/tags/<tag>`: `--repo` alone accepts any workflow of the
   repository that attests, so a run of an edited copy on a branch would pass.
   A lane pins the archive's sha256 and the plugin's own sha256 (the pin
   `opensesame plugins install` already requires).
3. **The release is published only for the commit that was built, and the
   workflow file is not what keeps others from starting one.** The first job
   (`scripts/release/tag-check.sh`) requires the tag to be `v<workspace
   version>` (or with a `-suffix`) and to name a commit `main` already holds,
   and every other job needs it, so a tag that fails spends no build minute.
   The commit it prints is the peel of `GITHUB_SHA`, because on a tag push that
   value can be an annotated tag's object; nothing compares the raw value. It
   resolves only full object names and full refs (`refs/remotes/origin/main`),
   since git reads a bare `origin/main` as a tag of that name first and the job
   fetches every tag. The build asserts its checkout is that commit; the release
   is created as a draft with every file attached, at `--target` the verified
   commit, after `publish` has run `gh attestation verify` on every file and the
   sums; the tag is asked of the API again just before the draft is published,
   and a tag that moved is not released. Every action is pinned by SHA; jobs get
   no token by default, and only the attest job (`id-token`, `attestations`) and
   the publish job (`contents`, and `attestations: read` for that check) write
   or read more than the repository. No secret beyond `GITHUB_TOKEN`.
   All of this lives in the workflow file at the tagged commit, which whoever
   pushes the tag controls: an edited copy can skip any of it. What stops that is
   outside the file. Once the owner applies it (`ops/github/release-tags.json`,
   with `ops/github/governance.mjs`, which `--verify` checks), only a repository
   admin can create a `v*` tag, so a copy of the workflow cannot be started
   from a tag by anyone else, and a branch-dispatched copy cannot create the
   tag a release needs. And a consumer who verifies with `--signer-workflow` and
   `--source-ref refs/tags/<tag>` rejects a run from a branch. The `release`
   environment, with a required reviewer if the owner sets one, adds an approval
   step before `publish`; it is not a boundary, because a copy of the workflow
   can omit `environment:`. The repository's optional "Immutable releases"
   setting stops a published release's assets and tag from being replaced
   afterwards.
4. **The binary finds the bridge shipped beside it.** `crates/env-spec` looks
   for the script in this order: `OPENSESAME_ENV_PARSE`, used as named; then
   `opensesame-env-parse.mjs` in the directory of the running executable after
   symlinks; then the checkout's copy. The file beside the executable is held
   to the rule a `node` found on `PATH` is held to (ADR 0006): the directory it
   is named in, the one it resolves into and the file itself owned by root or
   the caller, not writable by others and group-writable only by root's group
   or one of the caller's. One that is there and fails is an error that says
   which file or directory and why. It never falls through to the checkout's
   copy, so whoever could plant it cannot choose the script by breaking it. The
   checkout's copy is held to the same rule, because a release binary carries
   the path it was built from and a file that merely exists there is no reason
   to run it. With nothing beside the executable, no override and no checkout
   copy (a release binary run on its own), the error says where it looked.
5. **The bridge ships as one file.** `packages/env-spec-bridge` bundles itself
   and `@env-spec/parser` (no dependencies of its own) with esbuild into one ES
   module that imports only `node:` builtins. Which esbuild and parser build
   it is decided by `pnpm-lock.yaml`, and the workflow installs with
   `--frozen-lockfile`: the root `pnpm.overrides` rewrite esbuild's specifier
   to `>=0.25.0`, so the version in the package's `package.json` is not what
   pins it. Its tests run the bundle and the unbundled bridge on the
   repository's schemas and compare their output byte for byte, and bundle
   twice to the same bytes.
6. **macOS and Windows are not in the kit yet.** `native-platform-validation.yml`
   builds `opensesame` on macOS and Windows, but no job builds or runs the
   surrogate-proxy plugin there, and the proxied run is Linux only
   ([proxied-run quickstart](../operators/proxied-run-quickstart.md)). A target
   joins the matrix when a job has built and run both binaries on it.

## Consequences

- A downstream lane downloads a few megabytes by pinned digest instead of
  building the workspace; it still needs a `node` (named with
  `OPENSESAME_NODE` where the only one sits in a directory others can write).
- The release is a second artifact to keep honest. `ci-release-kit.test.mjs`
  pins the workflow's triggers, permissions, build order and publish order, and
  packs stand-in binaries twice to the same bytes on every TypeScript run; a
  change to the workflow file runs the TypeScript suite and no browser gate
  (`scripts/lib/ci-gates.mjs`).
- The bundle's bytes depend on the esbuild and parser versions the lockfile
  pins, not on the machine: module paths in its comments are written as they
  sit under the package's `node_modules`.
- A release build still carries the checkout path it was built from in the
  compiled-in fallback (`CARGO_MANIFEST_DIR`, `/home/runner/work/…`): the
  build's `--remap-path-prefix` rewrites paths in debug info and panic
  messages, not this string, which the compiler expands first. It is reached
  only when no bridge sits beside the binary and `OPENSESAME_ENV_PARSE` is
  unset, and it is held to the bridge's trust rule, so a local user who owns
  `/home/runner/...` on someone else's host cannot choose the script by putting
  a file there; a developer's own checkout passes. Compiling the fallback out of
  release builds would also remove the path from the binary and is not needed
  for safety.
- The check on the bridge is by path and bounded. It covers the file, the
  directory it is named in and the one a symlink resolves into; it does not
  look at the directories above them, which is also true of a `node` found on
  `PATH`, and `node` opens the file by path a moment after the check, so
  someone who can replace the whole kit directory from above can still win that
  race. Closing it means opening the file once, checking the descriptor and
  handing `node` the verified bytes, which is not done. On Windows the bridge
  is checked only to be a regular file, because the kit is Linux only and no
  Windows rule for it exists; running a kit there is unsupported.
- The `node` file is now held to the group rule its directory already was: a
  `node` that a group the caller is not in can write is passed over like one
  anyone can write (before, only its directory had the group test). A `node`
  reached through a link is also judged in the directory the link resolves
  into, as the bridge is.
- `publish` verifies the attestations itself before it creates the release,
  and `kit-archive.sh sums` refuses to write `SHA256SUMS` unless the bridge on
  its own is the one inside every kit; neither is needed for the artifact to be
  the same one by construction, and both make that checked rather than assumed.
- The binaries are not signed beyond the provenance attestation, and the tag
  must already name the version the binary reports (`opensesame --version`).
