# opensesame-security-events

The shared vocabulary for the Host security-event feed. Every detector — an
expiring certificate, a password found in a breach corpus, a provider incident
— converts its finding into one `SecurityNotice`, and from there it is
published on the hook feed, sent to the built-in notifier, and, at or above a
severity floor, raised as an alert. This crate defines the envelope, the
severity ladder, subscription filters, the delivery kinds and the renderings
for each alert standard. It does no I/O.

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway) (`security::dispatch` and
  the sinks in [`src/security`](../../apps/gateway/src/security)),
  [`opensesame-lifecycle`](../lifecycle), [`opensesame-breach-intel`](../breach-intel)
  and [`opensesame-agent-events`](../agent-events).
- **Builds on:** no workspace crates (`chrono`, `serde`, `serde_json`, `sha2`).
- A detector does not get its own notification path; it converts into
  `SecurityNotice` and inherits the rest.
- Nothing here can carry a credential: `SecurityNotice` has no field able to
  hold a value, and `safe_payload` strips secret-shaped keys from the source
  payload as a second fence.

## Surface

| Item | Role |
|---|---|
| `SecurityNotice`, `NoticeState` | The envelope; `family`, `alert_key`, `safe_payload`, bounded `summary_text` / `label_text` / `detail_text` |
| `Severity` | `Info`, `Warning`, `Error`, `Critical` — PagerDuty Events API v2's four rungs |
| `Delivery` | Where a matched event goes: `Webhook`, `Internal`, `Alertmanager`, `PagerDuty`, `A2h`. Every outbound sink is HTTPS; there is no syslog transport |
| `filter` | `matches`, `is_valid`, `family_of`, `WILDCARD_ALL`, `WILDCARD_SUFFIX` — event-type filters with `family.*` wildcards |
| `render::alertmanager` | Alertmanager v2 alert body (`INGEST_PATH` `/api/v2/alerts`) |
| `render::pagerduty` | PagerDuty Events API v2 body and `event_action` |
| `render::syslog` | RFC 5424 line, written locally by the built-in notifier |
| `MAX_SUMMARY_CHARS`, `MAX_LABEL_CHARS`, `MAX_DETAIL_CHARS` | Text bounds |

## Develop

```bash
cargo +1.88.0 test -p opensesame-security-events
```

Adding a delivery kind means changing `Delivery`, the storage schema's `CHECK`
and the gateway's route validation together.

## Related

- [ADR 0080](../../docs/adr/0080-security-event-hooks.md) — security-event hooks
- [ADR 0074](../../docs/adr/0074-expiry-lifecycle-hooks.md) — expiry lifecycle hooks
- [ADR 0081](../../docs/adr/0081-live-session-observation.md) — `agent.*` events on the same feed
