# tests/fuzz

Coverage-guided fuzzing for both planes. Parsers, token formats and state
machines are fed arbitrary input, and each harness asserts a security oracle —
attenuation never widens authority, expired or single-use claims are not
reused, malformed input is denied rather than accepted permissively, redaction
leaves no declared secret in the clear. A crash is a panic, a sanitizer hit or
a failed assertion. None of this runs in `pnpm verify` or CI; it is opt-in.

## Where it fits

- **Run by:** [`scripts/fuzz/`](../../scripts/fuzz) — `fuzz-pr-gate.sh`,
  `fuzz-batch.sh` and `jazzer-gate.sh`, behind the `pnpm audit:fuzz*` and
  `pnpm test:fuzz*` scripts.
- **Keeps:** tracked seeds are read-only inputs. The gates copy them into a
  private audit directory outside the checkout (`OPENSESAME_AUDIT_DIR`, default
  under `$TMPDIR`), and corpus growth and crash artifacts stay there.
- `pnpm test` runs the Jazzer.js package's Vitest suites (oracle and target
  unit tests), because `tests/fuzz/jazzer` is a pnpm workspace member.

## Surface

| Directory | What it is |
|---|---|
| [`cargo/`](cargo) | Cargo package `opensesame-fuzz`: 48 libFuzzer targets in `fuzz_targets/` over the Host-plane crates (grants, proof, authn, redaction, vault envelopes and attachments, claims, audit, env-spec, connectors, Bitwarden, KDBX, PKI parsers, transport security, NATS callout, gateway paths). Shared `Arbitrary` types and oracles in `src/`, seeds in `corpus/<target>/`. Excluded from the root Cargo workspace (it needs nightly) and carries its own `Cargo.lock`. |
| [`jazzer/`](jazzer) | pnpm package `@opensesame/fuzz`: 15 Jazzer.js targets in `src/`, each exporting `fuzz(Buffer)` — agent-auth contracts and tokens, audit redaction, the claim engine, client admission, origin normalization, safe metadata URLs, the task-bus contract, WebAuthn ceremonies and others. `src/run.ts` is the uninstrumented fallback runner. |
| [`clusterfuzzlite/`](clusterfuzzlite) | `project.yaml`, `Dockerfile` and `build.sh` for ClusterFuzzLite or OSS-Fuzz: builds every cargo-fuzz target with address sanitizer and zips seed corpora. No workflow uses it. |

## Develop

```bash
pnpm audit:fuzz                  # 60s per cargo target mapped from files changed vs origin/main
pnpm audit:fuzz:batch            # every cargo target, 3600s each; FUZZ_BATCH_BUDGET caps the total
pnpm test:fuzz                   # every Jazzer.js target, 30s each
pnpm test:fuzz:batch             # every Jazzer.js target, 300s each
cargo +nightly fuzz run <target> --fuzz-dir tests/fuzz/cargo     # one target by hand
cargo +1.88.0 test --manifest-path tests/fuzz/cargo/Cargo.toml --lib   # oracle unit tests
pnpm --filter @opensesame/fuzz test
pnpm --filter @opensesame/fuzz typecheck
```

`FUZZ_SECONDS` overrides the per-target time everywhere; `FUZZ_DIFF_BASE`
changes the diff base for `audit:fuzz`. Cargo targets need `cargo-fuzz` and a
nightly toolchain invoked as `cargo +nightly`; do not switch
`rust-toolchain.toml`. `test:fuzz` fails closed when the native Jazzer.js addon
cannot load; `JAZZER_ALLOW_FALLBACK=1` runs `src/run.ts` instead and reports
`DEGRADED`, never `CLEAN`.

To add a cargo target: add `fuzz_targets/<name>.rs` and its `[[bin]]` entry,
refresh and commit `cargo/Cargo.lock` (both gates run `--locked` and refuse a
stale lock), seed `corpus/<name>/`, map the crate to the target in
`map_targets` in `scripts/fuzz/fuzz-pr-gate.sh`, and add it to the table in
`docs/validation/fuzzing.md`. A Jazzer.js target is a new `jazzer/src/<name>.ts`
exporting `fuzz`; the gate picks up every non-test file except `oracles.ts`,
`provider.ts` and `run.ts`. A minimized crasher goes in
`cargo/regressions/<target>/`, which the gates also read as seeds.

## Related

- [`docs/validation/fuzzing.md`](../../docs/validation/fuzzing.md) — toolchain, oracles, crash triage, crate-to-target map
- [ADR 0036](../../docs/adr/0036-coverage-guided-fuzz-and-bounded-proofs.md) — coverage-guided fuzzing and bounded proofs
