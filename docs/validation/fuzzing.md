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
| Jazzer.js | Node ≥ 22; native `@jazzer.js/core` when the addon builds | `pnpm install`. `scripts/fuzz/jazzer-gate.sh` fails closed when the addon is not loadable; `JAZZER_ALLOW_FALLBACK=1` runs the local `tsx` runner that calls the same `fuzz(Buffer)` exports and reports `DEGRADED`, never `CLEAN`. |
| Shuttle | same 1.88, feature `concurrency-test` | pulled in as an optional dependency of each crate that has a Shuttle test |

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

- `tests/fuzz/cargo/fuzz_targets/` — libFuzzer binaries
- `tests/fuzz/cargo/src/` — shared `Arbitrary` types and security oracles
- `tests/fuzz/cargo/corpus/<target>/` — committed seeds; the gates copy them
  into a private audit directory outside the checkout, where corpus growth
  stays
- `tests/fuzz/cargo/artifacts/` — gitignored; `tests/fuzz/clusterfuzzlite/build.sh`
  puts built targets and seed-corpus zips there when `OUT` is unset. Crashes
  from `pnpm audit:fuzz*` and `pnpm test:fuzz*` land in a private audit
  directory instead (a fresh `opensesame-audit.*` directory under
  `OPENSESAME_AUDIT_DIR`, default `$TMPDIR`; the gate prints its path)
- `tests/fuzz/cargo/regressions/<target>/` — minimized crashing inputs to
  commit; the gates read them as seeds. The directory does not exist yet in
  this checkout
- `tests/fuzz/clusterfuzzlite/` — Dockerfile / `build.sh` / `project.yaml`
- `tests/fuzz/jazzer/` — Jazzer.js targets + oracle unit tests

`tests/fuzz/cargo/` is listed in the root workspace `exclude`. It is its own workspace
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

1. Confirm reproducibility: `cargo +nightly fuzz run <target> --fuzz-dir tests/fuzz/cargo <audit-dir>/artifacts/<file>`
   (the gate prints `Private audit artifacts: <audit-dir>`)
2. Minimize: `cargo +nightly fuzz tmin <target> --fuzz-dir tests/fuzz/cargo <crash>`
3. Copy the minimized input to `tests/fuzz/cargo/regressions/<target>/`
4. Fix the product code (not the harness, unless the oracle was wrong)
5. Write `docs/security/audits/YYYY-MM-DD-fuzz-<target>.md`
6. Re-run the target for at least 60s

TypeScript follows the same steps; its crashes are written to
`<audit-dir>/artifacts/<target>-*`.

## ClusterFuzzLite and OSS-Fuzz

This repo does **not** add `.github/workflows/cflite_*.yml`. The project
files under `tests/fuzz/clusterfuzzlite/` are the CFL/OSS-Fuzz contract:

- `project.yaml` — language rust, libFuzzer, address sanitizer
- `Dockerfile` — `gcr.io/oss-fuzz-base/base-builder-rust`
- `build.sh` — `cargo +nightly fuzz build --release` and seed corpus zips

To submit to hosted OSS-Fuzz later, copy those three files into
`projects/opensesame/` on `google/oss-fuzz`. Do not open that PR until
there is a real adoption or critical-infrastructure case.

## Kani bounds

Proofs live in `#[cfg(kani)]` modules next to the code. Current bounds:

- Grant interval (`crates/domain/src/grant.rs`): an `i64` clock in `[0, 10_000)`
- Rotation (`crates/rotation/src/lib.rs`): exhaustive `RotationState` enum
- Session control (`crates/session-observe/src/lease.rs`): exhaustive
  `ControlState` enum

`pnpm audit:kani` runs `cargo kani` over `opensesame-domain` and
`opensesame-rotation` only; the session-observe proofs are not part of it.

## Shuttle vs Turmoil

Shuttle tests are behind `--features concurrency-test` so `pnpm verify`
does not explore schedules. `pnpm audit:shuttle` runs the tests in
`opensesame-broker` (`shuttle_idempotency`, which drives the production
idempotency store, `opensesame_storage::Db`, from Shuttle threads),
`opensesame-proof` (`shuttle_replay`), `opensesame-rotation`
(`shuttle_rotation`) and `opensesame-domain` (`shuttle_authority`).

ADR 0036 defers Turmoil until a host graph that is not dual-writer SQLite
(ADR 0031) is worth the runtime change. Do not invent a dual-writer SQLite
cluster.

## Mapping: crate → Rust targets

| Crate | Targets |
|---|---|
| domain, grants | `capability_algebra`, `grant_attenuation`, `grant_serde`, `canonical_json`, `resource_match`, `protocol_negotiate`, `transport_bindings_config` |
| proof | `jwt_jwk`, `uri_normalize`, `replay_cache` |
| authn | `token_audience`, `device_auth`, `oidc_discovery` |
| authz | `nats_callout_eval` |
| redaction | `redaction` |
| human-vault | `vault_envelope`, `attachment_chunk` |
| claims | `claim_replay` |
| audit | `receipt_verify` |
| env-spec | `env_spec` |
| connection-broker | `connector_manifest`, `broker_seal`, `github_webhook_hmac` |
| connector-host | `connector_yaml` |
| connection-detect | `mcp_config`, `ini_parse`, `promote_request` |
| daemon | `promote_request`, `mcp_config` |
| protocol-mcp | `mcp_authz`, `resource_match` |
| protocol-aauth | `aauth_parse`, `protocol_negotiate` |
| provider-openbao | `openbao_response` |
| provider-openfga | `openfga_response` |
| provider-bitwarden | `bitwarden_encstring` |
| rotation | `rotation_fsm` |
| task-bus | `taskbus_url`, `xkeys_envelope` |
| xkeys | `xkeys_envelope` |
| tailscale-authn | `whois_response` |
| kdbx-bridge | `kdbx_parse` |
| vault-item-types | `vault_item_type` |
| storage | `certmgr_filter_parse` |
| pki-core | `pki_crl_parse`, `pki_csr_parse`, `pki_ocsp_request_parse`, `pki_pkcs12_parse` |
| gateway | `kv_v2_path`, `certificate_request` |
| transport-security | `transport_leaf_parse` |
| nats-callout | `transport_callout_envelope` |
| ingress-evidence | `transport_ingress_fields` |

`map_targets` in `scripts/fuzz/fuzz-pr-gate.sh` decides which of these
`pnpm audit:fuzz` runs for a diff; targets it does not map (such as
`attachment_chunk` and the PKI parsers) run only when a change touches
`tests/fuzz/cargo/` or through `pnpm audit:fuzz:batch`.
