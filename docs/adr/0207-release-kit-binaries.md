# ADR 0207 — A release kit of native binaries, verified by digest

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR 0006](0006-env-spec-delivery-modes.md) (the env-spec
  bridge, `OPENSESAME_NODE`), [ADR 0150](0150-surrogate-credentials-at-the-last-hop.md)
  §7 (plugins installed with a sha256 pin)
- **Implementation:** `.github/workflows/release-kit.yml`,
  `scripts/release/kit-archive.sh`, `packages/env-spec-bridge/scripts/bundle.mjs`,
  `crates/env-spec/src/node_bridge/script.rs`; operator guide
  [docs/operators/release-kit.md](../operators/release-kit.md). The workflow has
  not yet run on GitHub: what it builds is checked locally and by the tests
  named below, the release itself only by its first tag.

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
2. **A lane trusts a digest, not a name.** Archives are reproducible from the
   same commit and toolchain: entries sorted, every mtime the tagged commit's
   time (`SOURCE_DATE_EPOCH`), owner and group 0, fixed modes, ustar headers,
   `gzip -n`. Each file SHA256SUMS names gets a build-provenance attestation
   (`actions/attest-build-provenance`), bound to this workflow, commit and run,
   which `gh attestation verify` checks. A lane pins the archive's sha256 and
   the plugin's own sha256 (the pin `opensesame plugins install` already
   requires).
3. **The release is published only for the commit that was built.** The tag
   must name a commit `main` already holds; the release is created as a draft with every
   file attached, at `--target` the verified commit; the tag is asked of the
   API again just before the draft is published, and a tag that moved is not
   released. Every action is pinned by SHA; jobs get no token by default, and
   only the attest job (`id-token`, `attestations`) and the publish job
   (`contents`) write. No secret beyond `GITHUB_TOKEN`.
4. **The binary finds the bridge shipped beside it.** `crates/env-spec` looks
   for the script in this order: `OPENSESAME_ENV_PARSE`, used as named; then
   `opensesame-env-parse.mjs` in the directory of the running executable after
   symlinks; then the checkout's copy. The file beside the executable is held
   to the rule a `node` found on `PATH` is held to (ADR 0006): the directory it
   is named in, and the one it resolves into, owned by root or the caller, not
   writable by others and group-writable only by root's group or one of the
   caller's; the file itself owned by root or the caller and not writable by
   others. One that is there and fails is an error that says which file or
   directory and why. It never falls through to the checkout's copy, so
   whoever could plant it cannot choose the script by breaking it.
5. **The bridge ships as one file.** `packages/env-spec-bridge` bundles itself
   and `@env-spec/parser` (no dependencies of its own) with esbuild, a pinned
   devDependency, into one ES module that imports only `node:` builtins. Its
   tests run the bundle and the unbundled bridge on the repository's schemas
   and compare their output byte for byte, and bundle twice to the same bytes.
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
  compiled-in fallback (`CARGO_MANIFEST_DIR`, `/home/runner/work/…`). It is
  reached only when no bridge sits beside the binary and `OPENSESAME_ENV_PARSE`
  is unset; a kit always ships the bridge. Removing that fallback from release
  builds is left for a later change.
- The binaries are not signed beyond the provenance attestation, and the tag
  must already name the version the binary reports (`opensesame --version`).
