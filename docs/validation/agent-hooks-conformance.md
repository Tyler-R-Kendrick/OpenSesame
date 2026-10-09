# Agent Hooks 0.1 conformance — OpenSesame as a host

What was run to check that OpenSesame's own agent-driven runs are an
[Agent Hooks 0.1](https://github.com/responsibleai/agent-hooks/blob/v0.1.0-alpha.5/spec/AGENT-HOOKS-0.1.md)
host, what was observed, and what the result does and does not show.

[ADR 0159](../adr/0159-agent-hooks-interceptor.md) put OpenSesame on the
interceptor's side of the contract. This page is about the other side: the
runs `crates/rotation-web` orders — a web-login rotation
([ADR 0076](../adr/0076-autonomous-web-login-rotation.md)) and a registration
ceremony's captures ([ADR 0082](../adr/0082-agent-run-registration-ceremonies.md))
— emitting the spec's interception points so any interceptor, OpenSesame's
own included, governs them.

Two claims come out of it, and they are deliberately not the same claim:

| | Adapter name | What is driven | Declared capabilities | Vectors run |
|---|---|---|---|---:|
| **A** | `opensesame-rotation-web` | The rotation host as it is: `HookedTransport` and `host_run`, a tool router with no model calls | `tool_calls`, `int64_json` | 4 of 47 |
| **B** | `opensesame-rotation-web (emission engine, mock loop)` | The same `HookSession` and `host_run`, driven by the CTK's own scripted mock model and mock tools | `model_calls`, `tool_calls`, `int64_json` | 46 of 47 |

A is about what a rotation or capture run does. B is about the emission and
verdict machinery those runs are built on, and says nothing about a run. The
sections below state each, what it shows, and what it does not.

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
- A `pre_tool_call` transform is applied to **content, never to authority**.
  An interceptor is trusted (§1.4) to govern what a run says, not what it
  touches: which credential a run uses and where it is filled is the
  operator's and the executor's decision (ADR 0005, ADR 0076). So the
  credential `reference` of `fill_credential`, `assert_present` and
  `verify_login` (a candidate is filled by its handle, which is that
  reference), the capture `slot` of `capture_credential` and
  `capture_download`, and the **origin** a `navigate` reaches (scheme, host,
  port and userinfo, compared with the URL parser against the origin the
  executor proposed, so it also keeps a navigation inside the run's declared
  origin whenever the executor's own step is; a relative URL stays relative
  and an opaque or unparseable one can only stay identical) are *pinned*. A
  transform whose effective arguments change any of them is
  `host_error:transform_invalid`: the record is rewritten as for any other
  unapplicable transform, and the verb is not called with the altered value.
  The rule is a type, not a convention — every verb's argument type
  implements `Authority`, `Verb::Args` requires it, and the one bracket every
  verb goes through (`HookSession::bracket_named`) compares the proposed and
  effective pinned views, so a new verb cannot be added without saying which
  of its members are authority. What still transforms: a selector rewritten
  within the frame (`fill_credential`, `capture_credential`, `wait_for`,
  `submit`), a `navigate` moved to another path, query or fragment of the
  same origin, a redacted `read_dom_redacted` text, a dropped frame. This is
  a fail-closed reading of §5.2, as for the run request below. It changes the
  outcome of two replays of the vendored corpus's own scripts, which rewrite
  a URL to another origin: `tests/ctk_tool_seam.rs` now proposes a URL on the
  origin the script rewrites to (AH-CTK-021, 093), and asserts the
  cross-origin case is refused. `capture_download`'s `content_type` and a
  `screenshot_redacted` mask are not authority and stay rewritable. A tool
  known only by name (`HookSession::tool_call`, below) has no pinned member:
  the host cannot tell which of a model-named tool's arguments name a
  credential, a slot or a destination, so its transform is bound by shape
  (§4.2's `args` object) and nothing more.
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
- No lock is held while an interceptor or the approval resolver is awaited
  (§12.2.2, §12.2.4). An emission reserves under a short lock (phase check,
  context build, which assigns `sequence` atomically per §12.2.3), is
  dispatched by the SDK's own emitter without a lock, and settles under a
  short lock (phase, labels, record). The SDK emitter takes `&mut self`, but
  nothing in it changes between emissions besides its record buffer, so each
  emission gets a fresh emitter built from shared, immutable parts (the
  interceptors, resolver, composition, identity provider and approval
  redactor); composition, the fold, identity, the approval echo rule and the
  record projection are the SDK's, untouched. A verb parked on an approval
  therefore does not hold up another verb's emission. Records leave in
  `sequence` order: one that finishes early waits for the earlier ones, the
  wait lasting as long as the earlier emission stays parked (records of the
  emissions that complete meanwhile are buffered, and a sink sees none of them
  until it settles; the approval resolver owns any deadline), and an emission
  dropped before it finishes (a caller gave up) releases the records behind it and leaves its
  sequence unused (unique and ordered, not gap-free).
- The model points use the same three steps and the same locks. The
  `pre_model_call`/`post_model_call` pairing (§3.1.4) is a counter of
  `pre_model_call`s that proceeded, kept in the session state and only ever
  changed under the short lock: a `post_model_call` is refused without an
  emission when none is open, and otherwise claims one at reserve, so two
  posts in flight cannot answer the same pre whatever their interleaving (a
  post dropped before it finishes hands its claim back). A proceeding pre
  opens one at settle, and a turn's `output` closes any left open.
- A run's boundaries (`agent_startup`, `input`, `output`, `agent_shutdown`)
  do not overlap anything: each waits for every emission in flight and is
  emitted alone, so §3.1 holds by construction, and a shutdown queued behind a
  parked approval follows it. A verb outside a turn is refused without an
  emission (reason `opensesame:hook_out_of_order`, never recorded), because
  emitting it would break §3.1. A label an emission persists rides the
  contexts built after it settles; a verb proposed before that result existed
  does not carry it.
- Records are the SDK's payload-free §10.3 projection, delivered to a caller's
  `RecordSink` as they are made, in `sequence` order. With a sink installed the
  session keeps no records (a long relay session would otherwise hold every
  one); `with_retained_records()` asks for both and `with_max_records(n)`
  bounds what `records()` holds (oldest dropped, counted). With no sink, every
  record is kept, because `records()` is then the only way to read them. A `Refusal` carries
  the verdict's `reason`, never its `message`.

## Declared surface (§13.1)

| Item | Declaration | Why it is true |
|---|---|---|
| Capabilities | `tool_calls`, `int64_json` | No model calls: ADR 0076 §8 keeps the model in the remote runner, on the far side of the tool boundary, and no model client is a dependency of the crate — a tool router in §3.2's sense. `int64_json`: contexts are `serde_json` values holding `i64`. `bigint_json` is not claimed (`serde_json` coerces beyond-u64 literals at load). |
| Profiles | all four (`sequential/first_deny`, `sequential/run_all`, `parallel/strictest`, `parallel/unanimous`), every knob value | `SessionConfig.composition` is handed to the SDK emitter unchanged. |
| Identity provider | `jcs-sha256` (default); `null` and host-defined providers accepted per session | `SessionConfig.identity`; approvals bind to `jcs-sha256` (ADR 0159 §6). |
| `buffered_output` | `true` | The report is returned whole, only after the `output` verdict permits; nothing streams. |
| `tool_seam_host_error` | `terminate`, for `run_change_password_hooked` / `run_capture_steps_hooked` | A refused verb ends the run through the executor's own semantics (§6.2's "unless the host's own semantics terminate the turn"): a rotation reports `blocked: hook_refused` (or reconciles, if the refused step was the submit or the verification), and a capture run fails. The posture is declaration-only here: it post-dates the pinned runner (upstream #68), which neither reads it nor carries `run_outcome_by_posture`. |

## Claim A tuple (§13.3)

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
matching the exact SDK pin. Nothing is edited, filtered or skipped by id in
either claim's run: the only skips are the CTK's own capability gate.

## What a host must provide to run each kind of vector

Read from the pinned SDK (`agent_hooks::ctk`, `ctk_engine`, and the in-tree
`ReferenceHarness`) and the upstream `conformance/HARNESS.md` and
`RUNNER.md`. The runner owns the scripted interceptors, the scripted resolver,
the §9 redaction convention, the identity-provider mapping and every `expect`
assertion; the host owns the loop and reports a `RunRecord` (`outcome`,
`final_output`, `tool_invocations`, `identities`, `records`).

Every vector's `capabilities` list is a gate: a harness that does not declare
all of them skips it. The corpus splits four ways:

| Needs | Vectors | What the host must do |
|---|---:|---|
| nothing (lifecycle only) | 4 (AH-CTK-011, 022, 061, 074) | Emit `agent_startup`, `input`, `output`, `agent_shutdown` in §3.1's order, honour a block, and still emit the shutdown after a §6.1a startup deny. |
| `model_calls` | 3 (002, 003, 012) | Also dispatch the scenario's mock model: the Nth `pre_model_call` gets `model_script[N]`, `post_model_call` carries its `response`, and the final response's content is what `output` carries. |
| `model_calls` + `tool_calls` | 37 | Also: register the scenario's tool names at startup; take each proposed `tool_calls[i]` (`{id, name, args}`) and bracket it in `pre_tool_call`/`post_tool_call` under that `id`; invoke the scenario's mock tool (first `when_args` deep-equal clause wins, `is_error` honoured) with the **post-transform** arguments and log `{name, args}`; skip the tool and its `post_tool_call` on a `pre_tool_call` block; discard the result on a `post_tool_call` block; keep the loop going after a refused call (the default `tool_seam_host_error: continue`) and feed the model an error. |
| `+ int64_json` / `+ bigint_json` | 2 / 1 (090, 095 / 091) | As above, with a JSON layer that holds integers past 2^53 (`int64_json`) or past u64 (`bigint_json`; not available from `serde_json`). |

The composition, approval, identity-provider, transform, record and
enforcement parts are all in the last three rows: they are the SDK emitter's
behaviour (`InterceptionEmitter`), reached only when a host emits a proposed
tool call, so what a host must add for them is the wiring: hand
`composition`, `mode`, `identity_provider` and the resolver to the emitter
unchanged, register the redactor when `redact_for_approval` is set, and report
the emitter's own records and identity pairs. None of the alpha.5 vectors
carries `run_outcome_by_posture`, and the alpha.5 runner does not read a
posture, so `tool_seam_host_error` is declaration-only for both claims.

The dependency is on the **mock model**. In this corpus a tool call exists
only because a scripted model proposed it, and the runner gives a host no way
to invoke a tool directly. A host that makes no model calls has nothing to
attach the 40 tool-seam vectors to, however faithfully it brackets its tools.

## Does a model exchange pass through this host?

No, in no run mode, so claim A does not and must not declare `model_calls`.

- **ADR 0076 §8.** "No runtime LLM dependency enters a shipped binary. The
  model lives in the remote runner, on the far side of the tool boundary."
  T4 is a model that plans against a redacted DOM and calls the §1 tools; the
  host sees the tool calls, not the exchange that produced them. ADR 0082's C2
  (agentic ceremony) has the same shape.
- **ADR 0081.** The relay is ADR 0046 §7's tier 2 WSS relay, and what it
  carries is the sealed observation stream (action, thought and frame lanes,
  sealed to the owner's viewer key; "the relay is a courier and not a
  reader"). The thought lane is the model's *stated reason*, narrated by the
  runner; it is an observation record, not a request or a response the host
  dispatched, and the gateway holds ciphertext only.
- **ADR 0079.** Its relay is a TURN server for WebRTC between people's
  clients; no model is in that path.
- **The code.** `crates/rotation-web` has no model client (`Cargo.toml`), the
  gateway's web-login runner (`crates/gateway/src/web_login`) drives T3 recipe
  replays over the step queue with no model in the loop, and a T4 runner is a
  remote process.

So there is no `HookedModel` to add to a run path. What exists instead is the
engine's untyped surface (`src/hooks/dynamic.rs`): `HookSession::tool_call`
(a tool known by name, under the id a proposing model gave it) and
`HookSession::pre_model_call` / `post_model_call`. They go through the same
lock, lifecycle phase, context builder, emitter and label ledger as the
eleven typed verbs (`tool_call` shares the verbs' one `bracket_named`), and
no rotation or capture run calls them. They exist so the engine can be run
under the CTK's own contract, which is claim B.

## Claim B: the emission engine, through a mock-agent loop

```text
(opensesame-rotation-web (emission engine, mock loop), 0.1.0, agent-hooks/0.1,
 [model_calls, tool_calls, int64_json], all four profiles / all knobs,
 jcs-sha256 (+ null, vector-scoped), rust@0.1.0-alpha.5)
posture: tool_seam_host_error = continue; buffered_output = true
```

The harness is `crates/rotation-web/tests/mock_loop_support/mod.rs`, run by
`tests/agent_hooks_ctk_mock_loop.rs`. It is the CTK's own contract, a mocked
model and mocked tools, and it is the same loop the in-tree `ReferenceHarness`
runs, except that every point goes through production code:

- `host_run` supplies `agent_startup`, `input`, `output` and `agent_shutdown`
  and §6.1a, exactly as `run_change_password_hooked` uses it.
- Each scripted model turn is `HookSession::pre_model_call` then
  `post_model_call`; the loop continues from what the session returns (the
  transformed messages, the transformed response), and a refusal ends the turn.
- Each proposed tool call is `HookSession::tool_call` with the model's own
  `tool_call.id`, invoking the mock tool with the effective arguments and
  reading back the effective result. A named tool has no pinned authority (see
  above), so the corpus scripts that rewrite a URL to another origin apply
  here as written, while the typed `navigate` verb refuses them (claim A's
  supplementary `tests/ctk_tool_seam.rs`). A refused call becomes an error message to
  the mock model and the loop goes on: posture `continue`.
- The session, its `SessionConfig` (mode, composition, identity provider), the
  interceptors, the resolver and the §9 approval redactor are the ones a
  hosted run is built with.

The loop is the only thing that is not production code, and it decides only
what happens next from the vector's scripts. A mutation check shows it is not
vacuous: making the engine ignore a `pre_tool_call` transform fails eight
vectors (020, 021, 060, 080, 084, 086, 093, 105), and the first run of this
harness failed AH-CTK-001 on a real engine gap (a session minted its own
`tool_call.id` where a proposed call has one), which is why `tool_call` takes
the id.

**Declared surface, stated truthfully.** `model_calls` is true of this loop
and false of a rotation run; that is the whole reason the adapter carries a
different name. The claim attaches to the emission and verdict machinery, not
to any run. `int64_json` holds because contexts are `serde_json` values with
`i64`. `bigint_json` is not declared, for the reason the reference harness
gives.

### Observed report B (2026-09-28)

`cargo +1.88.0 test -p opensesame-rotation-web --test agent_hooks_ctk_mock_loop -- --nocapture`

| Part | Pass | Fail | Skip |
|---|---:|---:|---:|
| (untagged) | 15 | 0 | 0 |
| `approval_seam` | 8 | 0 | 0 |
| `composition/parallel_strictest` | 3 | 0 | 0 |
| `composition/parallel_unanimous` | 2 | 0 | 0 |
| `composition/sequential_first_deny` | 2 | 0 | 0 |
| `composition/sequential_run_all` | 5 | 0 | 0 |
| `enforcement/evaluate_only` | 1 | 0 | 0 |
| `enforcement/isolation` | 1 | 0 | 0 |
| `enforcement/post_action_deny` | 1 | 0 | 0 |
| `fail_closed/verdict_gate` | 1 | 0 | 0 |
| `identity_provider` | 4 | 0 | 1 |
| `record/decided_by` | 1 | 0 | 0 |
| `record/projection` | 1 | 0 | 0 |
| `verdict/warnings` | 1 | 0 | 0 |
| **Total** | **46** | **0** | **1** |

The one skip is AH-CTK-091 (`missing capabilities: ["bigint_json"]`), a
capability this adapter does not declare; nothing is skipped for any other
reason. **100% of the vectors applicable to the declared surface pass: 46 of
46.** The test pins the pass count, the skipped id and reason, and this table,
so a vector that starts or stops applying fails it. (The "ctk scripted
provider fault" lines on stderr are AH-CTK-096's provider panicking on
purpose.)

### What B shows, and what it does not

It shows that `HookSession`, the engine every hosted run emits through, honours
the verdict contract for composition (all four profiles and their knobs),
approval (resolution, echo rule, redaction, rejection, unions), identity
(`jcs-sha256`, `null`, a failing provider, I-JSON domain), transform
application and refusal, `evaluate_only`, fail-closed verdict gates, the §10.3
record projection, and both tool-seam denies, when driven end to end.

It does not show that any production run makes a model call (none does), that
a rotation or capture run emits what B's loop emits (A and the supplementary
tests cover that, on a mocked browser), or that the registered interceptors are
sound. It is a claim about machinery under CTK conditions. CLAIMS.md is plain
that a harness which re-implements dispatch attests nothing; B's loop
re-implements only the agent's decisions, not the emission, gating,
enforcement or recording, which are the production calls above.

## Re-run

```bash
cargo +1.88.0 test -p opensesame-rotation-web --test agent_hooks_ctk -- --nocapture
cargo +1.88.0 test -p opensesame-rotation-web --test agent_hooks_ctk_mock_loop -- --nocapture
```

Each fails on any failing vector and pins its pass set (A) or pass count and
skip (B) by id and number, so a vector that newly applies must pass rather than
join the skips unnoticed. `--nocapture` prints the per-part report and one line
per vector.

## Observed report A (2026-09-28)

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
`agent_hooks::context_identity`, with one exception in how they are read: for
`G-15-rfc8785-numbers` the test compares against RFC 8785 Appendix B's digits
(`9.999999999999997e+22`) rather than the vendored fixture's
`9.999999999999996e+22`, because this build parses every number as the nearest
double (`agent_hooks_ctk.rs`; ADR 0159's limits).

**100% of the vectors applicable to the declared surface pass — 4 of 4.**

## What A's skips mean, and the supplementary evidence

The pinned corpus reaches `pre_tool_call` only through a mock model: every
vector that exercises the tool seam also requires `model_calls`. For a tool
router that is the correct CTK outcome, and it means claim A itself exercises
none of this host's tool seam, composition profiles or approval seam. Declaring
`model_calls` to make them run would be false; claim B is the honest way they
run.

The tool seam of the rotation host is covered by the crate's own tests, which
are not part of either claim:

| File | Covers |
|---|---|
| `tests/ctk_tool_seam.rs` | The corpus's own tool-seam `interceptor_script`s (AH-CTK-021, 032, 040, 050, 070, 071, 092, 093), read from the vendored files and evaluated by the SDK's `ctk_engine::scripted_intercept`, driven through a real hosted verb: alias transform applied, escalation without a resolver stands, `evaluate_only` proceeds, warnings recorded, a panicking or malformed interceptor fails closed without invoking the tool, record projection. Scripts that match on a mock tool's name (`delete_files`, `http_get`) are not replayable here. |
| `tests/hooked_verbs.rs` | All eleven verbs bracketed; pre deny, pre transform applied, `transform_invalid`, post deny, post transform, an error never transformed into a success, frames droppable but not replaceable, a refused ledger read never "complete", out-of-order refusal, concurrent verbs. |
| `tests/hooked_authority.rs` | The pinned fields: a fill, presence assertion or login check cannot be pointed at another credential or candidate (also by replacing the whole argument object); a capture or download cannot be sealed into another slot; a navigation cannot change host, scheme, port or userinfo, cannot become protocol-relative, and a relative one cannot become absolute. Each asserts the inner transport saw nothing, the record is `transform_invalid` with `decided_by` null and `enforced_identity` = `input_identity`, and no `post_tool_call` was emitted. Positive controls: restating the reference unchanged, a selector rewrite in the frame (fill, capture, `wait_for`), a same-origin navigation rewrite. `src/hooks/authority.rs` unit-tests the destination comparison. |
| `tests/hooked_runs.rs` | Lifecycle order through `run_change_password_hooked`, startup/input/output denies (an output deny is `Withheld`, after the submit), an input or output transform that would change the request or the outcome refused as `transform_invalid`, a refused fill blocking before submit, escalation lifted by an approving resolver, `cancelled` when a person holds the page, a capture run. |
| `tests/hooked_concurrency.rs` | §12.2 under paused time: a verb parked on the approval seam does not delay another (measured against the frozen clock); sequences unique, contiguous and delivered in order; labels persisted per emission; a shutdown waits for the parked emission and nothing follows it; an abandoned emission releases the records behind it. |
| `tests/hooked_ledger.rs` | A refused ledger read in a capture run is a refusal, never the ledger: a report that listed sealed slots as outstanding would have the caller ask for them again, so under `tool_seam_host_error: terminate` the hosted run fails. |
| `tests/hooked_records.rs` | What the session keeps (no sink: all; sink: none unless asked; a limit), and that each per-emission emitter carries the session's approval redactor and identity provider. |
| `tests/hooked_labels.rs` | §5.4: a permit's labels resurface under the interceptor's namespace on every later emission, accumulate without duplicates, and are never resurfaced for a deny, an unapplied transform, a label the combined verdict dropped, or an unnamed or reserved namespace. |
| `tests/hooked_dynamic.rs` | The engine's untyped surface: a proposed call's own id on both emissions, a pre transform reaching the tool and a deny keeping it from running, an error staying an error through a post transform, model points in the same ordered session, model points and named tools refused without an emission outside a turn, a `post_model_call` refused without an emission unless a `pre_model_call` that proceeded is still open to pair with (§3.1.4), two posts in flight for one open pre leaving exactly one paired, a transform that leaves a model message, a model response or a tool's arguments off §4.2's shape refused as `transform_invalid`, and input that is off-shape to begin with refused as `context_invalid` without an emission (§6.3). |
| `tests/hooked_boundary_cut.rs` | A boundary emission (`agent_startup` or `agent_shutdown`) cut off by the run's deadline leaves a synthetic `host_error:interceptor_timeout` deny and still moves the session: a cut startup is followed by exactly one `error` shutdown, a cut shutdown by none. |
| `tests/hooked_shutdown_reason.rs` | `agent_shutdown`'s `summary.reason` follows how the run ended: a hook-refused step or a run blocked by recipe drift is `error`, a run that stood down for a person is `cancelled`, and neither is `completed`. |

## Limits

- **Not a security certification** (§1.4, `conformance/CLAIMS.md`). A pass
  attests that this adapter honours the verdict contract under CTK
  conditions. Agent Hooks is a cooperative contract; OpenSesame's boundary
  remains the Host API's `ConnectionRef` authorization (ADR 0005), and the
  tool boundary has no verb that returns a credential regardless of any hook.
- **Mocked I/O.** Both claims and the crate's own tests drive mocks (a browser
  for A, a model and tools for B). That a production run is wired through the
  hosted adapter is shown by the gateway tests in the last section, which drive
  the real step routes with a scripted driver, not by either claim.
- **Web-login rotations only.** The Host's runner starts web-login rotations.
  `run_capture_steps_hooked` is exercised by the crate's tests and walked under
  the `rotation-web-login` preset in the gateway's tests, but no gateway runner
  starts a capture run.
- **Two claims, not one.** A passes 4 of the 4 vectors its surface admits; that
  is narrow and honest. B passes 46 of 46 on a surface that includes
  `model_calls`, which no rotation run has. Read A for the run and B for the
  machinery, and do not quote B's 46 as a statement about a rotation.
- **B's posture is the loop's.** `tool_seam_host_error: continue` describes the
  mock loop; the rotation host's executors terminate (A's `terminate`). The
  alpha.5 corpus has no vector that distinguishes them.
- **Not filed upstream.** No row has been added to upstream
  `conformance/CLAIMS.md`. If one is, A and B are separate rows, and B's notes
  column states that its model calls are a mock loop over the engine.

## Production wiring

The Host's web-login runner (`crates/gateway/src/web_login`) is the production
path, and it is the hosted adapter, not a bare executor. A run is spawned and
tracked by the lifecycle scanner (`registry.rs`, `start.rs`), owns its job
through an atomic claim, and is driven by `launch.rs`. `Harness::open`
builds `HookedTransport::new(ExtensionTransport::new(BrowserChannel(..)),
HookSession::new(SessionConfig::new(run_id), interceptors, resolver)?
.with_record_sink(sink))` with the organization's own `OpenSesameInterceptor`,
and `drive` calls `run_change_password_hooked`. `settlement_of` maps
`HostedRunError::Refused` to a run that never began (the job records "not
submitted"), `HostedRunError::Withheld` and a refused or failed run after a
submit to a reconciliation, and a `pre_tool_call` refusal of the submit to
"not submitted" because the step was never enqueued.

What the surrounding tests pin, so the claims above are about a run and not
only about the machinery:

| Where | What it shows |
|---|---|
| `routes/agent_runs_web_login_tests.rs`, `web_login/custody_hooks_tests.rs` | A rotation runs hooked end to end through the real step routes; a denied verb is stopped before it is enqueued; custody steps are never hooked; nothing credential-valued reaches a record, a route body or a job detail. |
| `routes/agent_runs/outcome.rs`, `driver_tests.rs` | The settle route accepts only an outcome the pending step may produce, in its canonical encoding: a driver-added field (`{"outcome":"done","password":"x"}`) at any depth is refused with 422 and never stored; an outcome for another step is refused; a claim past its lease cannot settle before anyone reclaims it. |
| `routes/agent_runs_settle_tests.rs` | A credential-shaped string in an accepted outcome is stored as its marker, and a policy that denies credentials stores the step as refused. |
| `web_login/close_tests.rs` | A run is closed durably, read back, before its rotation is settled; a close that fails is retried with backoff and the job stays unsettled until it lands; one that never lands parks the job for reconciliation with a detail that says so, and the reaper closes the run later. |
| `web_login/claim_tests.rs`, `connection-broker` `rotation_web_login_claim_tests.rs` | The runner's job is created already claimed and never offered to the generic consumer; the claim is an organization-scoped compare-and-set with a persisted lease naming the run; recovery reads the lease. |
| `web_login/approver_tests.rs`, `agent_hook_approver_tests.rs` | A hooked rotation whose policy escalates a verb, with the Identity API replaced by a local server: the run is held with nothing enqueued until the person approves the request it was bound to, then proceeds whole; a refusal, a deadline (the interaction and request withdrawn), an approval bound to other content, an organization nobody is named for, and a deployment with no approver each leave that step undispatched; a partial approver configuration stops the Host from building. |
| `web_login/reaper_tests.rs`, `retention_tests.rs`, storage `agent_hook_records_fk_tests.rs` | A stopped gateway's runs are closed and jobs parked at startup and on a timer; expired runs go with their steps and hook records, and the hook records cannot outlive or name a run that does not exist (migration 0053). |
| `routes/agent_hooks/presets_walk_tests.rs` | The `rotation-web-login` preset proven on real hooked runs: a full change-password walk, a capture ceremony, and each of the eleven verbs decided by the real interceptor. |
| `routes/agent_runs_hook_records_tests.rs` | A hosted run's hook records are paged by `sequence` under the sealed log's entitlement, summarised on the run, and stand in for a sealed log the Host has no key to write. |

The Interaction-backed approver (`crates/agent-hooks/src/interaction`) is the
approval seam production plugs in, built per run by the launcher from the
deployment's `OPENSESAME_AGENT_HOOKS_APPROVER_*` configuration and the
organization's stored approver (`docs/operators/agent-hooks.md`); with neither,
every escalation stays a denial, which is §9's reading of an unresolved
approval. Its Identity API
client resolves routes with `Url::join` under an enforced path invariant, so a
base URL with a path prefix is kept (`interaction::http`, with
`tests/interaction_approver.rs` driving a prefixed server).
