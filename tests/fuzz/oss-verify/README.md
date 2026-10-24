# OSS Verify enrollment pack

[OSS Verify](https://theorem.dev/oss-verify/) (Theorem Labs) formally proves,
about a project's *compiled* fuzz binaries, that no input up to 64 MiB can
make a fuzz target crash, hang, or trip a sanitizer. Enrollment mirrors
OSS-Fuzz: a pull request adding `projects/opensesame/` to
[theorem-labs/oss-verify](https://github.com/theorem-labs/oss-verify) with a
`project.yaml`, `Dockerfile`, and `build.sh`. The decision to enroll is
[ADR 0211](../../docs/adr/0211-oss-fuzz-and-oss-verify-enrollment.md); the
filing checklist is
[docs/contributing/oss-programs.md](../../docs/contributing/oss-programs.md).

This directory holds that pack. It is **not** a copy of
`tests/fuzz/clusterfuzzlite/`: OSS Verify's build contract differs
materially from OSS-Fuzz's.

## How it maps onto this repository

| OSS Verify contract | This repo |
|---|---|
| `language: rust`, all four builds (plain, ubsan, asan, asan-ubsan) | the fuzz crate is its own workspace at `tests/fuzz/cargo`, excluded from the product workspace; the toolchain image brings its own pinned nightly (2025-07-16) with a sealed standard library, so `rust-toolchain.toml` stays at 1.88 |
| `$OUT` executables defining `LLVMFuzzerTestOneInput` | the 48 cargo-fuzz `[[bin]]` targets; their `fuzz_target!` bodies are re-linked through the OSS Verify driver by `oft_build_cargo_shim` (libFuzzer itself is replaced by their driver) |
| network-isolated compile | the `crates` directives in `sources` vendor every crate the targets' `Cargo.lock` names; cargo builds `--frozen --offline` |
| byte-reproducible double builds | `$SOURCE_DATE_EPOCH` is theirs; the source tree paths are fixed by the release layout; no timestamps or git-derived versions enter the binaries |
| hermetic targets (`abort()` on a failed property, no signal handlers, no env) | the harnesses already `assert!` (panic = abort), install no handlers, and read no environment |

The first wave (project.yaml `fuzz_targets`, eight targets) covers the
security-boundary families the in-repo oracles already assert and that are
hermetic under the OSS Verify contract: authority algebra
(`capability_algebra`, `grant_attenuation`) and parsers (`canonical_json`,
`jwt_jwk`, `pki_csr_parse`, `kdbx_parse`, `vault_item_type`,
`connector_manifest`). The seal/envelope targets (`vault_envelope`,
`broker_seal`) are not yet enrollable: sealing draws OS entropy for nonces
and keys (`crates/human-vault/src/lib.rs`,
`crates/connection-broker/src/crypto/envelope.rs`), which the contract
forbids — they join a later wave once the harnesses take a deterministic,
input-derived seam. Enlarging the wave is four files in lockstep:
`build.sh` (`opensesame_target <name>`), `sources` (`tree` + `crates` pair),
`project.yaml` (`fuzz_targets`), and nothing else.

## Files

- `project.yaml` — enrollment metadata; `primary_contact` is set at filing
  time and never committed (OSS Verify checks it belongs to a maintainer)
- `Dockerfile` — `${BASE_BUILDER}` + `fetch-commit` at the caller-supplied
  `COMMIT`; lays out per-target trees and vendored crates via `lay-out-sources`
- `sources` — tab-separated `lay-out-sources` directives (one `tree` + one
  `crates` per enrolled target)
- `build.sh` — per-target subshells through `release-target.sh` and the Rust
  recipe (`ov_target_begin` → `oft_build_cargo_shim` → `ov_target_build`)
- `patch_style.md` — which findings and patches the maintainers want

## Before filing (checklist owner: the maintainer filing the PR)

1. **Set `primary_contact`** in `project.yaml` (and in
   `tests/fuzz/clusterfuzzlite/project.yaml` for the OSS-Fuzz pack).
2. **Validate on Linux with Docker** (~10 GB free; this repo's Windows/arm64
   checkout cannot run the builder): clone theorem-labs/oss-verify, copy this
   directory to `projects/opensesame/`, then
   `python3 tools/validate.py projects/opensesame` and
   `tools/check --no-shell --twice opensesame`. The `--twice` run proves the
   byte reproducibility the proofs are stated over; expect first-run friction
   on any contract detail this pack got wrong — fix here, re-copy, re-check.
3. **Fork and PR** theorem-labs/oss-verify with `projects/opensesame/`
   (or point their coding-agent workflow at this pack's raw files).
4. After the merge, findings arrive at `primary_contact`; triage them by
   `docs/validation/fuzzing.md` § Crash triage, and review any AI-generated
   patch before applying it.
