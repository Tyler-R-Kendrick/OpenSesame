# opensesame-agent-events

The frozen `agent.*` event vocabulary for sandboxed agent runs, and the
conversion that puts those events on the one security-event feed. It is a feed,
not a notifier: the platform publishes a fact such as "this run is blocked and
waiting on a person", and every delivery — a webhook, an A2H intent, the
product's own UI — subscribes to the same fact. Host / authority plane; pure and
value-blind.

## Where it fits

- **Used by:** [`opensesame-a2h`](../a2h) and [`apps/gateway`](../../apps/gateway)
  (`security/dispatch.rs`, `security/delivery.rs`, `lifecycle/responders.rs`,
  `routes/a2h.rs`, `routes/lifecycle.rs`).
- **Builds on:** [`opensesame-security-events`](../security-events) —
  `AgentEvent::notice()` returns a `SecurityNotice`, which is the only way
  `agent.*` reaches subscribers. There is no second subscription table and no
  private fan-out.
- `agent.*` is the third family on ADR 0080's feed, beside `lifecycle.*` and
  `breach.*`.
- A request for a person carries its deadline: `AgentEvent::waiting` requires a
  `responds_by`, and `AgentEvent::reporting` refuses one.
- The payload is built key by key. Nothing is serialized from a caller's map,
  and no key matches the audit redactor's deny pattern (`token`, `value`,
  `secret`, `user_code`, `device_code`). `detail` is capped at
  `MAX_DETAIL_CHARS` (160).

## Surface

| Item | What it is |
|---|---|
| `EVENT_RUN_STARTED`, `EVENT_RUN_BLOCKED`, `EVENT_AWAITING_HUMAN`, `EVENT_CONTROL_GRANTED`, `EVENT_CONTROL_RELEASED`, `EVENT_RUN_RESUMED`, `EVENT_RUN_COMPLETED`, `EVENT_RUN_FAILED` | The frozen event names (`agent.run.started` … `agent.run.failed`) |
| `AGENT_EVENT_TYPES`, `EVENT_WILDCARD`, `is_agent_event_type` | The closed list, the `agent.*` subscription pattern, and a membership check |
| `AgentPhase` | The same states as an enum; `event_type()` maps back to the name |
| `AgentRun` | The run an event is about: ids, owner, origin, tier, control state — metadata only |
| `AgentEvent` | `waiting`, `reporting`, `seconds_to_respond`, `payload`, `from_payload`, `summary`, `notice` |
| `AgentEventError` | `MissingDeadline`, `UnexpectedDeadline` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-agent-events
```

Tests live inline in `src/lib.rs`.

## Related

- [ADR 0081](../../docs/adr/0081-live-session-observation.md) — live
  observation of agent runs and the `agent.*` feed
- [ADR 0080](../../docs/adr/0080-security-event-hooks.md) — one security-event
  feed, one envelope
- [ADR 0074](../../docs/adr/0074-expiry-lifecycle-hooks.md) — the feed rule this
  applies
