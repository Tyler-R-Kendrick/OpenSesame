# Item rotation

Rotation is a queue, not a hidden write. An account whose provider path exists
gets a default 30-day schedule; a format with only a synthetic generator says
that automatic rotation could not verify it.

## What can rotate

| Kind | Automatic | Manual action |
|---|---|---|
| Account (web login, ADR 0076) | Yes, every 30 days | Generate now |
| Format with a parser and generator (`card`, `token`, `api-key`, …) | No — no provider path | Generate now queues a request |
| Type with no generator | No | None |

The format generators are test-shaped (`.test` domains, test PANs, synthetic
keys). They are never used to overwrite a real item. Manual rotation therefore
queues a provider-side request; it does not write a generated value.

## Schedule and queue

`vault.rotation.schedules.v1` and `vault.rotation.events.v1` live in origin KV,
outside the sealed body. They contain an item id, type id, timestamps, reason and
state. They never contain a name, secret, candidate, or provider response, so a
locked vault can still be inspected.

- On unlock, every account with an https site gets the default schedule if it
  has none. A schedule the person disabled is kept disabled.
- On every app open, even while the vault is locked, a tick reads the schedules
  and queues each due item. Queueing is one event per item, so repeated opens
  roll up instead of multiplying work.
- On unlock, queued events are offered to the rotation relay. No relay is
  configured by default; the event is then marked `out-of-sync` and remains
  queued for the next open. The row and item page show that state.
- A later relay configuration retries `out-of-sync` events on the next open.

The queue has no persistent listener. A browser that was closed when a rotation
came due queues it on the next open. That is the intended event boundary, not a
failure.

## Manual rotation

`Generate now` enqueues the same event a schedule would, with reason `manual`.
It works for every generator-backed type. For a type without a verified provider
path, the panel carries the warning and the queued event stays out of sync until
a relay can take it.

## Relay boundary

`rotationSeams.relay` is the integration point. A relay receives only the
metadata event and answers accepted or refused. It must not return a secret.
Completing an event advances the schedule from the completion time and removes
the queue row.
