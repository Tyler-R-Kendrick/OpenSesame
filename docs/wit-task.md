# WIT task-scoped authority contracts

Versioned WIT packages extend OpenSesame without breaking existing `opensesame:host@1.0.0` guests.

## Packages

| Package | World | Purpose |
|---------|-------|---------|
| `opensesame:task@1.0.0` | `task` | Task/intent handles, authorize-and-invoke, restrict, terminate |
| `opensesame:proof@1.0.0` | `proof` | Proof handle + execute-authorized-proof with task/intent binding |
| `opensesame:mediation@1.0.0` | `mediation` | classify-result, acknowledge-transition |

## Security invariants

- **Opaque handles only** — `task-handle`, `intent-handle`, and `proof-handle` are host-owned resources; guests never receive secret bytes.
- **No `secrets.get`** — task/proof/mediation worlds intentionally omit secret materialization.
- **No arbitrary `sign(bytes)`** — proof execution is bound to task/intent fields; connector crypto remains purpose-bound in `wit/connector/world.wit`.
- **Ratchet shrink only** — `restrict` accepts a digest of a proposed capability subset; widening is rejected by the host engine.

## Task world (`wit/task/world.wit`)

```wit
authorize-and-invoke(binding, connection-ref, operation, resource, idempotency-key)
restrict(task, proposed-capabilities-digest, expected-state-version)
terminate(task)
```

Maps to Host API:

- `POST /api/v1/tasks` — start task (mint handle)
- `POST /api/v1/tasks/intents` — freeze intent (mint intent handle)
- `POST /api/v1/tasks/invoke` — execute a frozen intent by digest; the server holds
  the frozen bytes, so the caller names the digest and cannot restate the call
- `POST /api/v1/tasks/{id}/terminate` — terminate task

`POST /api/v1/intents` is the unfenced legacy path: it refuses requests that carry
`task_run_id` or `intent_digest` rather than pretending to honour them.

## Proof world (`wit/proof/world.wit`)

`execute-authorized-proof` requires:

- `task-run-id`
- `intent-digest`
- `task-state-version`

These fields bind proof execution to a frozen intent snapshot. Host rejects stale state versions.

## Mediation world (`wit/mediation/world.wit`)

- `classify` — returns mediation points for an operation (result buffer, request fence, audit witness).
- `acknowledge-transition` — records enforcement acknowledgement before a ratchet commit.

## Host compatibility

`wit/host/world.wit` remains at `@1.0.0` with **comment-only** optional import notes. Existing session/invoke exports are unchanged.

## Validation

Structural tests in `crates/host-core` assert:

- Task/proof/mediation WIT omit `secrets.get` and arbitrary signing entry points
- Required exports exist (`authorize-and-invoke`, `execute-authorized-proof`, `acknowledge-transition`)

```bash
cargo +1.88.0 test -p opensesame-host-core wit_task
```
