# Separate Rust credential test depth

Status: implemented; fresh hosted campaigns remain required before merge.
The October 7 local authentication/sealed-store all-target run passed 190 tests,
including 26 new native regressions, with all 13,902 tracked inputs unchanged.
Windows-only binaries executed zero cases on that Linux run and provide no
Windows proof. Nineteen platform/collector parser controls and 43 source-workflow
contract tests pass locally. These results do not establish coverage floors,
mutation admission, simulator/device behavior, or signed release readiness.

This adds a separate `Credential Rust depth` workflow: one per-file LLVM counter
job, eight core mutation shards, eight adapter shards on each of Linux, Windows
and macOS, and four libFuzzer jobs. Canonical Rust mutations also use eight
shards with a separate required disjoint-union collector. With optional extension
mutation enabled, the complete parent plan requires 98 actual jobs; without it,
97. The original eleven canonical families remain present. The current
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
`--gitignore true`, and two jobs. Raw admission fails on empty selections,
missed mutants, timeouts or no caught mutants. Unviable is reported separately,
never counted as caught. Tool timeout defaults and authored deadlines remain
unchanged. An adapter-only equivalence classification requirement may replace
only the adapter raw requirement after an explicitly reviewed committed policy
and genuine independently verified native proofs; strict raw results remain
unchanged and visible. Until that policy and evidence are approved, every
applicable missed mutant, including possible equivalents, still fails. Full raw per-mutant reports remain available for review. This scope
covers the native/sealed owner-admission and delivery adapters; the pure queue
harness does not prove those adapters. Host gateway/broker authority paths are
outside this finite proposed scope and retain their existing direct tests.

Each shard runs its own genuine baseline and uses the pinned tool's zero-based
`--shard k/8 --sharding round-robin` selection. Exact full, native-applicable and
assigned inventories remain in the artifact. All eight partitions must form a
complete disjoint union, with matching source, tool and compiler context. Adapter
applicability uses explicitly reviewed source hashes and cfg intervals, checked
against actual native Cargo/compiler cfg. Unknown source or cfg fails. Supported
targets must all execute their applicable inventory; unsupported-only stubs stay
outside the supported-runtime claim. Native Python prerequisites and actual raw
outcomes are independently checked by the collector. Native shard artifacts use
one upload root so the strict collector can find their reports directly.

The historical 4c adapter campaign remains a failure: 279 mutants, 155 caught,
100 missed, 24 unviable and zero timeouts. Target inactivity and possible source
equivalence do not rewrite that result. The current collector still rejects any
applicable missed mutant, including equivalent constant expressions; any future
semantic proof must be independently reviewed and reported separately from
authentic execution. The eight-way plan adds runtime headroom within the existing
360-minute job deadline; successful completion still requires actual execution.

## Proposed adapter classification contract

This section defines a separately reviewed future policy, not an admission
approval or a claim that a native equivalence proof has run. Canonical Rust,
credential core, TypeScript mutation, coverage, fuzz and OS/device checks retain
their current gates. Every applicable adapter mutant still executes on every
supported native target under the unchanged exact scope and eight partitions.

Only the 21 exact reviewed adapter objects may be classified after independent
proof of the current source/operator/function/cfg span, native Rust1.88 and
cargo-mutants27.1/default features, locked dependency/crypto schema, actual
completed baseline linkage, original selected artifact and exact verifier code.
Unknown/moved/changed objects or inputs fail and require re-review. A predicted
constant, cached same-name artifact, discovery-only record or producer PASS is
not proof. Supported-cfg proofs never extend to unsupported targets.

Raw Caught, Missed, Unviable and Timeout statuses and original tool exits remain
untouched. Only an actual Missed with genuinely successful Build/Test phases
may receive an independently replayed domain-equivalent classification. A
Timeout, missing/incomplete baseline, uncompleted outcome or Unviable cannot
be equivalent. Historical raw failures remain failures and are never re-scored.

Retain full generated, applicable, inactive and per-platform execution lists
and denominators. Within applicable outcomes report raw Caught C, Missed M,
Unviable U and Timeout T, plus exact equivalent subset E of M and unresolved
Q=M−E. Show E within raw Missed, not as Caught or an omitted object. No
“100% killed” score may combine C and E. Unviable stays explicit and is never
a kill. All eight partitions and all native platform unions must be complete.

The separately named adapter non-equivalent requirement can pass only after
every original prerequisite, source freshness, complete actual campaign and
independent proof passes, at least one genuine Caught exists under the current
nonvacuity rule, no Timeout/unknown/incomplete result exists, and Q is empty.
Every applicable viable object without an independently verified exact
equivalence disposition must have actual raw Caught status. Raw admission
still fails when M is nonempty, even if this separate requirement passes.

Any adoption must explicitly amend adapter leaf and collector contracts to
name that separate requirement while retaining original raw runner/tool exits
and reports. It must never accept a generic failed matrix, unexplained runner
error, skipped/canceled family or failed setup/source/upload prerequisite.
No continue-on-error, selector ignore, runtime policy override, new heuristic
exemption or deadline increase follows. Fresh ordinary gates and genuine
native capture/proof/campaign results are required before merge.

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
