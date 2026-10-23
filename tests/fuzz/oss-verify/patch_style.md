# Patch style

OpenSesame's maintainers want findings first; a patch is welcome when it
comes with one.

## Findings we want

A finding is useful when it names a real oracle violation in product code:
malformed input answered permissively, a security field lost by
canonicalization, an envelope that seals or opens with the wrong key, an
attenuation that widens authority. The in-repo oracles
(`tests/fuzz/cargo/src/lib.rs`, `docs/validation/fuzzing.md` § Security
oracles) state the properties each target asserts; a finding against one of
those properties is exactly what the target exists for.

Findings about harness bugs (a wrong oracle, a mis-shaped `Arbitrary` type)
are also useful, and are fixed in `tests/fuzz/cargo/`, not product code.

## Patches we accept

- Product-code fixes land in the crate the finding names, with a regression
  fixture under `tests/fuzz/cargo/regressions/<target>/` where one is
  possible, and a dated record in `docs/security/audits/` for anything
  security-relevant.
- Rust follows rustfmt (1.88.0, the repo's pinned toolchain) and clippy
  pedantic; a patch must build with `cargo +1.88.0 test --workspace
  --all-targets`.
- Keep the diff minimal: no drive-by refactors, no dependency bumps, no
  toolchain changes.
- A build patch (static linking, cross-compilation, version stamps) belongs
  in this pack, never as a product-code change — the reverse of the OSS
  Verify rule, and the same boundary.

## What we do with patches

Every patch is read by a maintainer before it is applied. AI-generated
patches are treated as a strong hint, not as reviewed code.
