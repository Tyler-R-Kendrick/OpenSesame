# Fuzzing, proofs, and concurrency verification

This is the operator guide for cargo-fuzz, ClusterFuzzLite-style local runs,
Jazzer.js, Kani, Miri, and Shuttle. Product tests stay on `pnpm verify`.
These tools are opt-in gates.

## Toolchain

| Work | Toolchain | Install |
|---|---|---|
| Product crates | Rust **1.88.0** (`rust-toolchain.toml`) | already pinned |
| cargo-fuzz / libFuzzer | nightly rustc + `cargo-fuzz` | Install the CLI with a new-enough rustc (`cargo +1.94.0 install cargo-fuzz`). Builds themselves need nightly because cargo-fuzz passes `-Zsanitizer=address`. `rustup toolchain install nightly && rustup default` is **not** required — keep `rust-toolchain.toml` on 1.88 and invoke `cargo +nightly fuzz …`. |
| Kani | Kani’s own toolchain | `cargo install --locked kani-verifier && cargo kani setup` |
| Miri | nightly + `miri` component | `rustup toolchain install nightly && rustup component add miri --toolchain nightly` |
| Jazzer.js | Node ≥ 22; native `@jazzer.js/core` when the addon builds | `pnpm install`. `scripts/jazzer-gate.sh` falls back to the local `tsx` runner that calls the same `fuzz(Buffer)` exports. |
| Shuttle | same 1.88, feature `concurrency-test` | pulled as an optional dev-dep |

Do not change `rust-toolchain.toml` to nightly.

## Commands

```bash
pnpm audit:fuzz            # 60s/changed target (CFL PR analogue)
pnpm audit:fuzz:batch      # long run; FUZZ_SECONDS / FUZZ_BATCH_BUDGET
pnpm test:fuzz             # Jazzer.js 30s/target
pnpm test:fuzz:batch       # Jazzer.js longer
pnpm audit:kani
pnpm audit:miri
pnpm audit:shuttle
```

Override duration with `FUZZ_SECONDS`. Override the Miri nightly with
`MIRI_TOOLCHAIN`.

## Layout

- `fuzz/fuzz_targets/` — libFuzzer binaries
- `fuzz/src/` — shared `Arbitrary` types and security oracles
- `fuzz/corpus/<target>/` — committed seeds (and locally grown corpus)
- `fuzz/artifacts/` — gitignored crashes
- `fuzz/regressions/<target>/` — minimized crashing inputs, committed
- `infra/clusterfuzzlite/` — Dockerfile / `build.sh` / `project.yaml`
- `packages/fuzz/` — Jazzer.js targets + oracle unit tests

`fuzz/` is listed in the root workspace `exclude`. It is its own workspace
so libFuzzer rustflags stay off the product crates.

## Security oracles

Every harness that can reach the check asserts some of:

1. Attenuation never widens authority
2. Intersection never invents authority
3. Revoked grants stay invalid
4. Expired / single-use claims cannot be reused
5. Tenant, issuer, subject, resource, audience bindings survive
6. Canonicalization does not change a digest’s meaning
7. Malformed input is deny/error, never a permissive fallback
8. `decode(encode(x))` keeps security fields
9. Rotation / receipt verify never accepts an unintended key generation
10. Redaction never leaves a declared secret field in the clear

A crash is a panic, sanitizer hit, or failed `assert!`.

## Crash triage

1. Confirm reproducibility: `cargo +nightly fuzz run <target> fuzz/artifacts/<file>`
2. Minimize: `cargo +nightly fuzz tmin <target> <crash>`
3. Copy the minimized input to `fuzz/regressions/<target>/`
4. Fix the product code (not the harness, unless the oracle was wrong)
5. Write `docs/security/audit-YYYY-MM-DD-fuzz-<target>.md`
6. Re-run the target for at least 60s

TypeScript follows the same steps with `packages/fuzz/artifacts/`.

## ClusterFuzzLite and OSS-Fuzz

This repo does **not** add `.github/workflows/cflite_*.yml`. The project
files under `infra/clusterfuzzlite/` are the CFL/OSS-Fuzz contract:

- `project.yaml` — language rust, libFuzzer, address sanitizer
- `Dockerfile` — `gcr.io/oss-fuzz-base/base-builder-rust`
- `build.sh` — `cargo +nightly fuzz build --release` and seed corpus zips

To submit to hosted OSS-Fuzz later, copy those three files into
`projects/opensesame/` on `google/oss-fuzz`. Do not open that PR until
there is a real adoption or critical-infrastructure case.

## Kani bounds

Proofs live in `#[cfg(kani)]` modules next to the code. Current bounds:

- Capability selectors: two-character actions/resources
- Grant interval: `i64` clocks in `[0, 10_000]`
- Rotation: exhaustive enum
- Replay cache: capacity 2
- Receipt key id: 32-byte keys

## Shuttle vs Turmoil

Shuttle tests are behind `--features concurrency-test` so `pnpm verify`
does not explore schedules. The broker test models the idempotency table
without sqlx (SQLite is not a Shuttle runtime).

Turmoil (callback-edge duplicate claim, crash-before-audit) is listed in
ADR 0036 as a follow-up. Do not invent a dual-writer SQLite cluster
(ADR 0031).

## Mapping: crate → Rust targets

| Crate | Targets |
|---|---|
| domain, grants | `capability_algebra`, `grant_attenuation`, `grant_serde`, `canonical_json`, `resource_match`, `protocol_negotiate` |
| proof | `jwt_jwk`, `uri_normalize`, `replay_cache` |
| authn | `token_audience`, `device_auth`, `oidc_discovery` |
| redaction | `redaction` |
| human-vault | `vault_envelope` |
| claims | `claim_replay` |
| audit | `receipt_verify` |
| env-spec | `env_spec` |
| connection-broker | `connector_manifest`, `broker_seal` |
| protocol-mcp | `mcp_authz`, `resource_match` |
| protocol-aauth | `aauth_parse`, `protocol_negotiate` |
| provider-openbao | `openbao_response` |
| provider-openfga | `openfga_response` |
| rotation | `rotation_fsm` |
