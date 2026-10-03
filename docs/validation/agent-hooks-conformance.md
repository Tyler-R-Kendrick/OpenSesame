# Agent Hooks 0.1 conformance — OpenSesame as a host

What was run to check that OpenSesame's own agent-driven runs are an
[Agent Hooks 0.1](https://github.com/responsibleai/agent-hooks/blob/v0.1.0-alpha.5/spec/AGENT-HOOKS-0.1.md)
host, what was observed, and what the result does and does not show.

[ADR 0150](../adr/0150-agent-hooks-interceptor.md) put OpenSesame on the
interceptor's side of the contract. This page is about the other side: the
runs `crates/rotation-web` orders — a web-login rotation
([ADR 0076](../adr/0076-autonomous-web-login-rotation.md)) and a registration
ceremony's captures ([ADR 0082](../adr/0082-agent-run-registration-ceremonies.md))
— emitting the spec's interception points so any interceptor, OpenSesame's
own included, governs them.

## What the host is

`crates/rotation-web/src/hooks/`:

- `HookedTransport<T>` decorates the tool boundary (`BrowserTransport`, and
  `CeremonyTransport` when `T` can capture). Every verb is one
  `pre_tool_call` / `post_tool_call` pair under one `tool_call.id`; the
  arguments are `tool_call.args`, the result is `tool_result.value`.
- A `pre_tool_call` transform is **applied**: the effective `args` are
  deserialized back into the typed call and the inner transport is called with
  them. A transform the verb cannot take (a number where a selector goes, an
  unknown member — every argument type is `deny_unknown_fields`) is refused
  and recorded as `host_error:transform_invalid`, never ignored.
- A block at `pre_tool_call` means the inner verb is not called and no
  `post_tool_call` is emitted (§6, §6.2); at `post_tool_call` the result is
  discarded as an error (§6.1). Both answer `StepError::Refused`, so the
  ordering executors' existing fail-closed handling of a failed step takes
  over — nothing is submitted after a refused fill or assertion.
- `host_run` (and `run_change_password_hooked` / `run_capture_steps_hooked`,
  which call it) emits `agent_startup` (tools registered = the verb names),
  `input` (the run request: kind, recipe id, origin — never a credential or a
  candidate), `output` (the run report) and `agent_shutdown` with
  `completed`, `error` or `cancelled`, in §3.1's order. A startup deny
  processes nothing and still emits the shutdown, reason `error` (§6.1a).
- The run request (`input`) and the run report (`output`) are facts the host
  acts on, not content to rewrite: a transform may leave them as they were
  and nothing else. A transform that would change the recipe or origin, or
  restate a rotation's outcome (a `completed` rotation reported as `blocked`
  is a lockout), is `host_error:transform_invalid`. That is a fail-closed
  reading of §5.2; the spec itself only names unresolvable paths.
- A refusal is split on whether the run acted. `HostedRunError::Refused`
  means nothing ran (startup or input). `HostedRunError::Withheld` means the
  run finished and its report was refused at `output` (§6). Whatever it did
  to the site stands, and the caller must reconcile rather than treat the
  run as never begun.
- When the host rewrites a record to `host_error:transform_invalid`, it sets
  `decided_by` to null and `enforced_identity` to `input_identity` (§10.3:
  "equal to `input_identity` when no transform was applied").
- `result_labels` (§5.4) are carried forward. Each interceptor is wrapped so
  its own permit's labels are noted under the namespace it registers as
  (`Interceptor::name`, a legal unreserved §4.6 namespace). A label is
  persisted only when the host acted on the emission and the combined verdict
  names it, and it is resurfaced as `extensions.<namespace>.source_labels` on
  every later emission of the run. It is session-sticky because the remote
  model's derivations are invisible to the host; over-labelling can only make
  a label policy refuse more.
- Emission is serialized through one lock holding the context builder, the
  emitter and the lifecycle phase, so `sequence` is assigned atomically and
  records are in `sequence` order even while verbs run concurrently (§12.2);
  the verbs themselves run outside the lock. A verb outside a turn is refused
  without an emission (reason `opensesame:hook_out_of_order`, never recorded),
  because emitting it would break §3.1.
- Records are the SDK's payload-free §10.3 projection, delivered to a caller's
  `RecordSink` as they are made and kept on the session. A `Refusal` carries
  the verdict's `reason`, never its `message`.

## Declared surface (§13.1)

| Item | Declaration | Why it is true |
|---|---|---|
| Capabilities | `tool_calls`, `int64_json` | No model calls: ADR 0076 §8 keeps the model in the remote runner, on the far side of the tool boundary, and no model client is a dependency of the crate — a tool router in §3.2's sense. `int64_json`: contexts are `serde_json` values holding `i64`. `bigint_json` is not claimed (`serde_json` coerces beyond-u64 literals at load). |
| Profiles | all four (`sequential/first_deny`, `sequential/run_all`, `parallel/strictest`, `parallel/unanimous`), every knob value | `SessionConfig.composition` is handed to the SDK emitter unchanged. |
| Identity provider | `jcs-sha256` (default); `null` and host-defined providers accepted per session | `SessionConfig.identity`; approvals bind to `jcs-sha256` (ADR 0150 §6). |
| `buffered_output` | `true` | The report is returned whole, only after the `output` verdict permits; nothing streams. |
| `tool_seam_host_error` | `terminate`, for `run_change_password_hooked` / `run_capture_steps_hooked` | A refused verb ends the run through the executor's own semantics (§6.2's "unless the host's own semantics terminate the turn"): a rotation reports `blocked: hook_refused` (or reconciles, if the refused step was the submit or the verification), and a capture run fails. The posture is declaration-only here: it post-dates the pinned runner (upstream #68), which neither reads it nor carries `run_outcome_by_posture`. |

## Claim tuple (§13.3)

```text
(opensesame-rotation-web, 0.1.0, agent-hooks/0.1, [tool_calls, int64_json],
 all four profiles / all knobs, jcs-sha256, rust@0.1.0-alpha.5)
posture: tool_seam_host_error = terminate; buffered_output = true
```

The harness (`crates/rotation-web/tests/ctk_support/mod.rs`) drives the
production emission path — a `HookedTransport` and its `HookSession` through
`host_run`, the function `run_change_password_hooked` calls — with only the
browser I/O mocked. A vector's `model_script` stands for the remote agent: its
final response content is the report the run returns at `output`.

## Corpus

47 vectors plus the golden identity file, vendored byte for byte from
`responsibleai/agent-hooks` tag `v0.1.0-alpha.5` (commit
`61952932e52d5dab091a64677f19272daae619f8`) into
[`spec/agent-hooks/conformance/`](../../spec/agent-hooks/conformance/README.md),
matching the exact SDK pin.

## Re-run

```bash
cargo +1.88.0 test -p opensesame-rotation-web --test agent_hooks_ctk -- --nocapture
```

The test fails on any failing vector, and pins the pass set and the skip count
by id and number, so a vector that newly applies must pass rather than join
the skips unnoticed. `--nocapture` prints the per-part report and one line per
vector.

## Observed report (2026-09-28)

| Part | Pass | Fail | Skip |
|---|---:|---:|---:|
| (untagged) | 4 | 0 | 11 |
| `approval_seam` | 0 | 0 | 8 |
| `composition/parallel_strictest` | 0 | 0 | 3 |
| `composition/parallel_unanimous` | 0 | 0 | 2 |
| `composition/sequential_first_deny` | 0 | 0 | 2 |
| `composition/sequential_run_all` | 0 | 0 | 5 |
| `enforcement/evaluate_only` | 0 | 0 | 1 |
| `enforcement/isolation` | 0 | 0 | 1 |
| `enforcement/post_action_deny` | 0 | 0 | 1 |
| `fail_closed/verdict_gate` | 0 | 0 | 1 |
| `identity_provider` | 0 | 0 | 5 |
| `record/decided_by` | 0 | 0 | 1 |
| `record/projection` | 0 | 0 | 1 |
| `verdict/warnings` | 0 | 0 | 1 |
| **Total** | **4** | **0** | **43** |

Passing: AH-CTK-011 (deny at `input` blocks the turn), AH-CTK-022 (transform
at `agent_startup` → `transform_target_forbidden`), AH-CTK-061 (zero
interceptors fail closed), AH-CTK-074 (§6.1a startup deny, shutdown still
emitted). Every skip is `missing capabilities: ["model_calls"]` (AH-CTK-091
also `bigint_json`). The golden identity vectors pass against
`agent_hooks::context_identity`.

**100% of the vectors applicable to the declared surface pass — 4 of 4.**

## What the skips mean, and the supplementary evidence

The pinned corpus reaches `pre_tool_call` only through a mock model: every
vector that exercises the tool seam also requires `model_calls`. For a tool
router that is the correct CTK outcome, and it means the CTK itself
exercises none of this host's tool seam, composition profiles or approval
seam. Declaring `model_calls` to make them run would be false.

The tool seam is covered instead by the crate's own tests, which are not part
of the conformance claim:

| File | Covers |
|---|---|
| `tests/ctk_tool_seam.rs` | The corpus's own tool-seam `interceptor_script`s (AH-CTK-021, 032, 040, 050, 070, 071, 092, 093), read from the vendored files and evaluated by the SDK's `ctk_engine::scripted_intercept`, driven through a real hosted verb: alias transform applied, escalation without a resolver stands, `evaluate_only` proceeds, warnings recorded, a panicking or malformed interceptor fails closed without invoking the tool, record projection. Scripts that match on a mock tool's name (`delete_files`, `http_get`) are not replayable here. |
| `tests/hooked_verbs.rs` | All eleven verbs bracketed; pre deny, pre transform applied, `transform_invalid`, post deny, post transform, an error never transformed into a success, frames droppable but not replaceable, a refused ledger read never "complete", out-of-order refusal, concurrent verbs. |
| `tests/hooked_runs.rs` | Lifecycle order through `run_change_password_hooked`, startup/input/output denies (an output deny is `Withheld`, after the submit), an input or output transform that would change the request or the outcome refused as `transform_invalid`, a refused fill blocking before submit, escalation lifted by an approving resolver, `cancelled` when a person holds the page, a capture run. |
| `tests/hooked_labels.rs` | §5.4: a permit's labels resurface under the interceptor's namespace on every later emission, accumulate without duplicates, and are never resurfaced for a deny, an unapplied transform, a label the combined verdict dropped, or an unnamed or reserved namespace. |

## Limits

- **Not a security certification** (§1.4, `conformance/CLAIMS.md`). A pass
  attests that this adapter honours the verdict contract under CTK
  conditions. Agent Hooks is a cooperative contract; OpenSesame's boundary
  remains the Host API's `ConnectionRef` authorization (ADR 0005), and the
  tool boundary has no verb that returns a credential regardless of any hook.
- **Mocked I/O.** The CTK run and the supplementary tests drive a mocked
  browser. They do not show that a production run is wired through the
  hosted adapter; see the next section.
- **Four vectors.** The claim is honest and narrow. It will widen when the
  upstream corpus carries tool-router vectors, or if this host ever makes
  model calls itself.
- **Not filed upstream.** No row has been added to upstream
  `conformance/CLAIMS.md`.

## Production wiring

No production path constructs a `BrowserTransport` today: the gateway's
agent-run routes (`crates/gateway/src/routes/agent_runs.rs`) queue and settle
`StepRequest` JSON for a driver without linking this crate. When a run
executor lands, it wraps its transport in `HookedTransport::new(transport,
HookSession::new(SessionConfig::new(run_id), interceptors, resolver)?
.with_record_sink(sink))` and calls `run_change_password_hooked` /
`run_capture_steps_hooked` instead of the bare executors. It maps
`HostedRunError::Refused` to a run that never began, and
`HostedRunError::Withheld` to a run that needs reconciliation.
