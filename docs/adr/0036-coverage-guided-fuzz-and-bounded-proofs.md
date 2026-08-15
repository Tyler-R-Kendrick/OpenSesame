# ADR 0036 — Coverage-guided fuzzing and bounded proofs

## Status
Accepted

## Context
The authority plane already has unit tests, battle tests, `proptest` on
capability algebra, and a local static-analysis gate suite. The remaining
honest gap (`docs/validation/battle-test-critique.md`) was persistent
coverage-guided fuzzing, bounded model checks, UB detection, and
schedule/network exploration.

ClusterFuzzLite and Jazzer.js are usually hosted as GitHub Actions. This
repository has a permanent no-`.github/` policy (ADR-adjacent: `AGENTS.md` §8,
`CONTRIBUTING.md`). Hosted OSS-Fuzz is desirable later but depends on
adoption or a critical-infrastructure argument the project cannot yet make.

## Decision
1. **cargo-fuzz** lives in `fuzz/`, excluded from the product workspace so
   libFuzzer profiles cannot leak into Rust 1.88 crates. Structured inputs
   implement `Arbitrary`; parsers may take bounded bytes.
2. **ClusterFuzzLite’s project contract** (`infra/clusterfuzzlite/` Dockerfile,
   `build.sh`, `project.yaml`) is in-tree. PR-style and batch runs are
   `scripts/fuzz-pr-gate.sh` and `scripts/fuzz-batch.sh` plus
   `ops/routines/nightly-fuzz-batch.md`. No GitHub Actions workflows.
3. **Jazzer.js** targets live in `packages/fuzz` and run via
   `scripts/jazzer-gate.sh` / `pnpm test:fuzz`. Same crash-triage convention
   as Rust. No Actions job.
4. **Kani** proofs sit next to the functions they check (`#[cfg(kani)]`).
   They are not part of `pnpm verify`.
5. **Miri** runs periodically (`scripts/miri-gate.sh`) on crates without
   Wasmtime/sqlx/reqwest FFI.
6. **Shuttle** explores grant/idempotency/replay/rotation schedules behind
   the `concurrency-test` feature. Turmoil is deferred until a host graph
   that is not dual-writer SQLite (ADR 0031) is worth the runtime change.
7. **OSS-Fuzz**: the in-repo CFL files *are* the submission pack. Do not
   file `google/oss-fuzz` until there is a convincing acceptance case.
8. Long fuzz, Kani, Miri, and Shuttle stay out of `pnpm verify`.

## Consequences
- Security oracles (attenuation, intersection, replay, bindings,
  canonicalization, fail-closed parse, round-trip, key generation,
  redaction) are shared code, not comments in individual harnesses.
- A crash is minimized into `fuzz/regressions/<target>/` (Rust) or
  `packages/fuzz/artifacts/` (TS) and fixed like any other bug.
- Agents and humans opt into `pnpm audit:fuzz` on authority-plane PRs.
