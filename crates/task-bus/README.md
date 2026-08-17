# OpenSesame TaskBus

CloudEvents-shaped bus events behind a Rust trait. Default adapter is
**in-memory** (unit tests). Optional **NATS JetStream** adapter when built with
`--features jetstream`.

## Subject / stream conventions

| Item | Value |
|------|--------|
| Stream | `OPENSESAME_EVENTS` |
| Subjects | `opensesame.events.>` |
| Durable consumer | `opensesame-worker` |
| Callout namespace (reserved, not used here) | `opensesame.callout.>` |

## Operator env

```bash
# Memory (default — also what unit tests use)
export OPENSESAME_TASKBUS=memory

# JetStream (compose NATS on :4222)
export OPENSESAME_TASKBUS=nats
export NATS_URL=nats://127.0.0.1:4222

# Equivalent: omit OPENSESAME_TASKBUS and set NATS_URL only
export NATS_URL=nats://nats:4222
```

Gateway (`opensesame-gateway`) and the identity outbox worker read the same
variables. Compose wires `NATS_URL=nats://nats:4222` on gateway/worker.

## Verify

```bash
cargo +1.88.0 test -p opensesame-task-bus --all-targets
# With compose NATS up:
cargo +1.88.0 test -p opensesame-task-bus --features jetstream -- --ignored
```

Postgres remains the authoritative Identity outbox (ADR 0010). JetStream is a
drain / Host bus — not a second source of truth.
