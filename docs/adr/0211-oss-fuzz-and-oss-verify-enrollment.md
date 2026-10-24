# ADR 0211 — OpenSesame enrolls in OSS-Fuzz and OSS Verify

- Status: Accepted
- Date: 2026-10-23
- Amends: [ADR 0036](0036-coverage-guided-fuzz-and-bounded-proofs.md)
  (Decision 7: "do not file `google/oss-fuzz` until there is a convincing
  acceptance case")
- Builds on: [ADR 0212](0212-release-kit-binaries.md) (the release posture this
  makes public), [ADR 0080](0080-security-event-hooks.md) (every security fact
  becomes a `SecurityNotice` — a hosted-fuzzer crash is triaged through the
  same audit trail)

## Context

The fuzz estate is already built: 48 cargo-fuzz targets with committed seed
corpora, 16 Jazzer.js targets, local CFL-analogue gates
(`pnpm audit:fuzz*`), and a ClusterFuzzLite submission pack under
`tests/fuzz/clusterfuzzlite/`. ADR 0036 wrote that pack in OSS-Fuzz's own
format but deferred filing it upstream until the project could make an
acceptance case, because at the time the repository had no `.github/`
directory and no public release posture.

That posture now exists: the repository runs the required CI checks, publishes
the Pages app on every merge, ships native binaries through the release kit
(ADR 0212), carries a public SECURITY.md with private vulnerability
reporting, and scans itself on a schedule (`security.yml`). The remaining
honest gap is that the fuzz estate runs only where a maintainer remembers to
run it: a hosted fuzzer is the one layer that keeps running when nobody is
watching, and OSS Verify adds a machine-checked proof about the compiled
binary rather than the source.

## Decision

1. **Hosted OSS-Fuzz**: file the enrollment PR against `google/oss-fuzz`
   with the pack under `tests/fuzz/clusterfuzzlite/` (project.yaml, Dockerfile,
   build.sh — Apache-2.0 headers included, since they live in Google's
   repository). Filing steps and the pre-filing checklist live in
   `docs/contributing/oss-programs.md`.
2. **Sanitizers**: enroll with `sanitizers: [address]` only. The canonical
   enrolled Rust projects (hyperium et al.) ship address only; Rust UBSan
   builds are not yet reliable enough to bet a first acceptance on. Adding
   `undefined` is a one-line `project.yaml` change once accepted and stable.
3. **OSS Verify**: maintain an enrollment pack for Theorem Labs' OSS Verify
   (`tests/fuzz/oss-verify/`), which proves — about the compiled riscv64
   binaries, in Rocq — that no input up to 64 MiB makes a fuzz target crash,
   hang, or trip a sanitizer. Its build contract differs materially from
   OSS-Fuzz's (static riscv64 musl binaries, their own fuzzing driver in place
   of libFuzzer, hermetic network-isolated builds, byte-reproducible double
   builds), so the pack is a port, not a copy: a per-target
   `ov_target_begin`/`ov_target_build` flow through their Rust recipe, with
   the target's crates vendored by the `crates` directive of
   `lay-out-sources`. The first wave is eight targets across the
   security-boundary families the oracles already assert and that are
   hermetic under the contract: `capability_algebra`, `grant_attenuation`,
   `canonical_json`, `jwt_jwk`, `pki_csr_parse`, `kdbx_parse`,
   `vault_item_type`, `connector_manifest`. The seal/envelope targets wait
   for a deterministic entropy seam (their sealing draws OS randomness,
   which the contract forbids).
4. **The submission packs stay in-tree and stay the source of truth.** Both
   upstream PRs are generated from this repository; a change to the fuzz
   estate updates the packs here in the same commit. The packs' local
   continue-to-run duty (the `pnpm audit:fuzz*` gates and the nightly batch
   routine) is unchanged — hosted enrollment adds a layer, it does not
   replace one.
5. **Crash intake**: ClusterFuzz and OSS Verify report to the
   `primary_contact` address (set in both packs before filing; not committed
   here). Findings convert into the existing triage procedure
   (`docs/validation/fuzzing.md` § Crash triage) and, where they are real
   product bugs, `docs/security/audits/` records. OSS Verify's AI-generated
   patches are reviewed like any external patch: never applied unread.
6. **Community programs** — OpenSSF Scorecard, Dependabot, gitleaks and
   OSV-Scanner on a schedule, the OpenSSF Security Insights file, and the
   remaining community files (SUPPORT.md, MAINTAINERS.md, FUNDING.yml,
   issue/PR templates where absent, Dependabot config, repository topics) are
   part of the same enrollment posture; the running map is
   `docs/contributing/oss-programs.md`.

## Consequences

- The fuzz estate gains a layer that runs without a maintainer present; crash
  reports arrive by email and must be triaged like any `SecurityNotice`.
- The OSS Verify port is the project's first riscv64 musl cross-build of the
  fuzz crate; its `tools/check --no-shell --twice` (byte reproducibility) has
  to pass on a Linux host with Docker before filing, which this repository's
  Windows/arm64 checkout cannot do — the checklist records that step as the
  filer's.
- The in-repo CFL files gain Apache-2.0 headers so they can live in
  google/oss-fuzz without license churn.
- ADR 0036's Decision 7 deferral is lifted; its no-Actions rules for the
  *fuzz* workloads stay (hosted OSS-Fuzz is upstream's infrastructure, not a
  `.github/workflows/` job here).
- A real name and email enter Google's and Theorem's infrastructure; the
  contact address is the filer's choice recorded upstream, not in this tree.
