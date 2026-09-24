# opensesame-a2h

The A2H (Agent-to-Human) v1.0 client for the Host / authority plane: the
channel a blocked agent run uses to reach a person. `OpenSesame` is an A2H
*client*, never a gateway — it hands an intent to whichever gateway the
deployment configures, and that gateway owns channel selection, failover and
quiet hours. The crate builds the envelope, maps `agent.*` phases onto A2H
intents, and verifies what the gateway posts back.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (`src/routes/a2h.rs`).
- **Builds on:** [`opensesame-agent-events`](../agent-events) (the phases it
  maps) and [`opensesame-session-observe`](../session-observe)
  (`UntrustedText`, applied to third-party text before it lands in an SMS,
  email or push body).
- A2H is one subscriber to the `agent.*` feed, beside Standard Webhooks — not a
  private path from the runner to a phone.
- An A2H reply may only *narrow* authority. `ResponseAuthority` has two values,
  `Acknowledge` and `Cancel`; a reply that would grant control or resume
  autonomy is `AuthorityError::WouldWiden`, whatever the assurance level.
- `ERR.QUIET_HOURS` and `ERR.RATE_LIMITED` are `DeliveryOutcome::Suppressed`,
  never "delivered".
- Nothing the gateway sends back is trusted: callback HMAC in constant time,
  timestamp tolerance, `responds_to` against the sent message, then delivery id
  for idempotency.

## Surface

| Module / item | What it is |
|---|---|
| `envelope` (re-exported) | Wire types: `A2hMessage`, `A2hResponse`, `IntentType`, `Decision`, `ErrorCode`, `AssuranceLevel`, `CallbackConfig`; limits `MAX_TTL_SEC`, `MIN_TTL_SEC`, `MAX_TITLE_CHARS`, `MAX_BODY_CHARS`; `A2H_VERSION` |
| `intent` | `intent_for(AgentPhase)`, `message_for`, `assurance_for`, `authority_for`, `IntentContext`, `ResponseAuthority` |
| `verify` | `verify_callback`, `sign`, `parse_signature`, `ExpectedReply`, `VerifyError`, `TIMESTAMP_TOLERANCE_SECONDS` |
| `DeliveryOutcome` | `Delivered`, `Suppressed`, `Retryable`, `Permanent`; `for_error(ErrorCode)` |

The crate does no I/O; the gateway sends and receives.

## Develop

```bash
cargo +1.88.0 test -p opensesame-a2h
```

`tests/protocol.rs` is organised around the three failures that matter: an
escalation that outlives its run, a reply that widens authority, and a
suppressed message recorded as delivered.

## Related

- [ADR 0081](../../docs/adr/0081-live-session-observation.md) §10 — A2H as a
  delivery mode for blocked runs
- [ADR 0080](../../docs/adr/0080-security-event-hooks.md) — the security-event
  feed `agent.*` publishes on
