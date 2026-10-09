# opensesame-agent-events

The frozen `agent.*` event vocabulary for sandboxed agent runs, and the
conversion that puts those events on the one security-event feed. It is a feed,
not a notifier: the platform publishes a fact such as "this run is blocked and
waiting on a person", and every delivery — a webhook, an A2H intent, the
product's own UI — subscribes to the same fact. Host / authority plane; pure and
value-blind.

## Where it fits

- **Used by:** [`opensesame-a2h`](../a2h),
  [`crates/gateway`](../../crates/gateway) (`security/dispatch.rs`,
  `security/delivery.rs`, `lifecycle/agent_phase.rs`, `routes/a2h.rs`,
  `routes/lifecycle.rs`, `run_lease.rs`, `web_login/reaper.rs`) and
  [`opensesame-surrogate-proxy`](../surrogate-proxy) (`surrogate_refusal_notice`).
  [`opensesame-session-observe`](../session-observe) takes it as a
  dev-dependency only, for a drift test.
- **Builds on:** [`opensesame-security-events`](../security-events) —
  `AgentEvent::notice()` returns a `SecurityNotice`, which is the only way
  `agent.*` reaches subscribers. There is no second subscription table and no
  private fan-out.
- `agent.*` is the third family on ADR 0080's feed, beside `lifecycle.*` and
  `breach.*`. `surrogate.*` (ADR 0150 §5) is the fourth, and lives here because
  a surrogate is issued to an agent run and reports under it.
- A request for a person carries its deadline: `AgentEvent::waiting` requires a
  `responds_by`, and `AgentEvent::reporting` refuses one.
- The payload is built key by key. Nothing is serialized from a caller's map,
  and no key matches the audit redactor's deny pattern (`token`, `value`,
  `secret`, `user_code`, `device_code`). `detail` is capped at
  `MAX_DETAIL_CHARS` (160).
- A surrogate refusal is converted from plain strings — the broker's
  `RefusalCode::as_str()` and its optional run, provider and detail — so this
  crate does not depend on `invoke-through`. An unknown code is refused, not
  published. The detail is attacker-chosen (the host a surrogate was sent to,
  the site it was found at), so it is carried only when it is shaped like a
  host or a site name and holds no surrogate in any case or encoding; otherwise
  it is withheld and named in the payload's `withheld` list, and the notice is
  still published. `tests/surrogate_vocabulary_drift.rs` reads the broker's
  refusal module as text and fails when the two vocabularies differ.

## Surface

| Item | What it is |
|---|---|
| `EVENT_RUN_STARTED`, `EVENT_RUN_BLOCKED`, `EVENT_AWAITING_HUMAN`, `EVENT_CONTROL_GRANTED`, `EVENT_CONTROL_RELEASED`, `EVENT_RUN_RESUMED`, `EVENT_RUN_COMPLETED`, `EVENT_RUN_FAILED` | The frozen event names (`agent.run.started` … `agent.run.failed`) |
| `AGENT_EVENT_TYPES`, `EVENT_WILDCARD`, `is_agent_event_type` | The closed list, the `agent.*` subscription pattern, and a membership check |
| `AgentPhase` | The same states as an enum; `event_type()` maps back to the name |
| `AgentRun` | The run an event is about: ids, owner, origin, tier, control state — metadata only |
| `AgentEvent` | `waiting`, `reporting`, `seconds_to_respond`, `payload`, `from_payload`, `summary`, `notice` |
| `AgentEventError` | `MissingDeadline`, `UnexpectedDeadline` |
| `SURROGATE_EVENT_TYPES`, `SURROGATE_EVENT_WILDCARD`, `SURROGATE_SUBJECT_KINDS` | The frozen `surrogate.*` names (`surrogate.ambiguous` … `surrogate.out_of_scope`), the `surrogate.*` pattern, and the `agent_run` / `surrogate_proxy` subject kinds |
| `SurrogateFence` | The nine fences; `parse` takes a refusal code exactly, `severity()` is the documented ladder (`error` for misdirected, foreign caller, revoked; `warning` for misplaced, out of scope, ambiguous, cleartext; `info` for unknown, expired) |
| `SurrogateRefusalReport` | The broker's refusal as plain strings; its `Debug` never prints their text |
| `SurrogateEvent`, `surrogate_refusal_notice` | The vetted event and the conversion into a `SecurityNotice` |
| `SurrogateNoticeError` | `UnknownCode`, `InvalidOrganization` |
| `surrogate::carries_surrogate` | Whether text holds a surrogate's marker in any case, or a hex run as long as its body |

## Develop

```bash
cargo +1.88.0 test -p opensesame-agent-events
```

Unit tests live in `src/tests.rs` (`agent.*`) and `src/surrogate/tests.rs`
(`surrogate.*`, one per way a surrogate could reach the feed).
`tests/surrogate_sinks.rs` renders every notice through Alertmanager,
`PagerDuty` and RFC 5424 and searches each for the surrogate.

## Related

- [ADR 0081](../../docs/adr/0081-live-session-observation.md) — live
  observation of agent runs and the `agent.*` feed
- [ADR 0080](../../docs/adr/0080-security-event-hooks.md) — one security-event
  feed, one envelope
- [ADR 0074](../../docs/adr/0074-expiry-lifecycle-hooks.md) — the feed rule this
  applies
- [ADR 0150](../../docs/adr/0150-surrogate-credentials-at-the-last-hop.md) —
  surrogate credentials, and why every refusal is a tripwire
