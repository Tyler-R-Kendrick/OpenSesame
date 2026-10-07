# Separate Rust credential test depth

Status: applied. Nine current metadata-parser controls pass locally. Four static workflow controls and the earlier minimal-crate Cargo 1.88.0/public-API oracle execution retain their original recorded source attribution; all four earlier oracle controls passed without failures or ignored cases. Current-source crate compilation and campaign execution remain pending. No coverage percentage, caught-mutant count,
fuzz-iteration count, or campaign PASS is claimed. Windows persistence activation
remains an independent decision requiring actual current-source platform proof.

This adds a separate `Credential Rust depth` workflow: one per-file LLVM counter
job, separate core and adapter mutation jobs, and four libFuzzer jobs. The current
canonical mutation selection, coverage floors (69% lines / 67% functions), and
PR fuzz mapping remain unchanged. The branch-local parent test-depth workflow now calls this reusable workflow and
requires its admission result alongside its existing families when test depth is
explicitly requested. Actual execution on the new signed source is still pending;
adding a workflow does not itself change GitHub branch-protection settings.

The 10 core files and 12 adapter files are explicit in
`credential-rust-depth.json`. Coverage runs all targets for human-vault,
authenticator-core and sealed-store, and reports actual line/function/branch
counters for every scoped file. A missing, duplicate, uninstrumented or wholly unexecuted scoped
file fails reporting. Each selected file must have nonzero executed line and function counters. Zero branch counters remain accurately reported; no substitute
percentage floor is introduced. A null branch percentage means LLVM exported
no branch counters; it is not a claim of branch coverage. Linux counters exclude
Windows-only code. OS Keychain/Keystore, simulator/device and signed-release
checks remain separate required platform evidence.

Mutation runs use pinned cargo-mutants 27.1.0, the actual crate test suites,
`--gitignore true`, and two jobs. Empty file selections, missed mutants, timeouts
or no caught mutants fail. Unviable mutants are reported separately; they are
not counted as caught. Tool timeout defaults and authored test deadlines are
unchanged. Full raw per-mutant reports remain available for review. This scope
covers the native/sealed owner-admission and delivery adapters; the pure queue
harness does not prove those adapters. Host gateway/broker authority paths are
outside this finite proposed scope and retain their existing direct tests.

The four new targets use public production APIs without widening visibility:

| Target | Oracle and bounds |
| --- | --- |
| `retired_records_parse` | Strict record roundtrip, context refusal, unknown-field and 3-record cap controls; input bounded to 32KiB+1. No Argon2 call per fuzz iteration. Existing exact-UTF8/KDF tests remain required. |
| `canary_registry_validator` | Registry/installed-validator parsing, real context-bound digest, genuine synthetic MCP list, production-tool refusal without state change; 32KiB+1 raw prefix. |
| `observation_wire` | Real public AES/HMAC golden vector, altered-envelope refusal, genuine wrong-package ACK refusal, exact skew/expiry boundaries; 8KiB+1 packet and 2KiB+1 ACK prefixes. An authenticated packet is closed metadata, not production authority. |
| `observation_outbox_fsm` | At most 64 transitions and 16 retained reservations; genuine ACKs, independent public-state reservation model, replay, retry bounds, disable/replace, preserved budget, expiry and owner-witness hashing; 128KiB+1 persisted-state prefix. |

All production crypto executes normally. The public deterministic vector uses
numeric bytes 0..63 only in the fixture reconstruction. New packages use the
public production seal function with its actual random IV/nonce/UUID. There is
no receiver HTTP call, connector call, cookie access, real credential, or model
call in any harness. A public policy-byte fixture tests witness hashing; it is
not an owner-authentication bypass or a claim of OS authentication proof.

Private `Package::body`, ACK body, deterministic sealing, and owner root/key
ports stay private. Consequently, randomized wire tests cannot manufacture
arbitrary authenticated malicious plaintext through private serialization or
deterministic-IV helpers; they use public sealing plus the independently
computed golden vector. The pure state machine cannot force native/sealed
fresh-owner admission. Existing actual adapter tests and the separate adapter
mutation job address that boundary.

The new `tests/fuzz/credentials-cargo` is an independent minimal workspace:
human-vault, libfuzzer-sys, base64, chrono and serde_json only. Direct registry
versions are exact pins already present in the original locked graphs. The
original broad fuzz crate, its manifest/lock/lib and canonical target mapping
stay unchanged. The standalone credential lock is genuinely Cargo-generated,
with no compilation implied. Root Cargo exclusion is unnecessary because the
new crate declares its own `[workspace]`.

Each fuzz job executes four exact named positive/negative oracle controls first,
then runs the selected real engine for 60 seconds. `FUZZ_SECONDS` can request a
separate bounded campaign up to 3600 seconds. The original per-input
`-timeout=10` stays intact and `-max_len=131073` bounds maximum corpus input.
All corpus growth/crash artifacts are private runner output; committed seeds
are read-only public inputs. Completion requires a genuine nonzero libFuzzer
summary, not successful compilation alone. Nine metadata-parser control cases
cover absent/duplicate/uninstrumented/wholly unexecuted counters and zero/absent branch measurements, wrong scopes, empty or failed
mutations, missing/zero fuzz execution, and missing/duplicate/ignored/failed
named Rust controls.

Before campaigns: review the applied code, run the existing strict formatting,
complexity and coupling gates without raising baselines, check the Cargo-generated standalone
lock against final frozen inherited dependencies, compile and execute all four controls, and verify parser compatibility
against actual pinned tool output. The strict parser intentionally fails on
unknown cargo-mutants/list/libFuzzer diagnostics; its authored example fixtures
are not proof of actual tool-schema compatibility. Run each hosted family on
an exact recorded source SHA and retain logs, exact exit statuses, raw reports,
source freshness, tool versions, and runner capacity. Investigate surviving
mutants/crashes instead of adding exclusions.
