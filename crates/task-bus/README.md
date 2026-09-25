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
| Durable consumer (backup wakes) | `opensesame-backup` |
| System subjects (Host publishes, callout users never) | `opensesame.events.system.>` |
| Reserved *application* prefix (NOT the callout wire) | `opensesame.callout.>` |

The NATS **auth callout** is the server's native `$SYS.REQ.USER.AUTH`
request/reply in the AUTH account (`ops/nats/secure-callout.conf`, bridge in
`crates/nats-callout`). `opensesame.callout.>` is an unrelated reserved
application prefix and is never that wire.

## Delivery semantics (ADR 0141)

| Call | Guarantee |
|---|---|
| `publish` | Idempotent on JetStream: `Nats-Msg-Id` = event `id`, `Nats-Expected-Stream: OPENSESAME_EVENTS`; a repeat inside the 2-minute duplicate window is stored once |
| `drain(max)` | At most once — events arrive already acked. For wakes whose work re-reads an outbox. A payload that is not a `BusEvent` is terminated, never returned as an error |
| `process(max, handler)` | At least once — the handler runs first; `Ok` is acked with server confirmation, `Err` is nak'd with a delay that doubles per delivery (`Redelivery::nak_delay` up to `max_nak_delay`), a failure on the last delivery is counted in `ProcessReport::exhausted`, an undecodable payload is terminated. Handlers must be idempotent |

The stream is bounded (`StreamLimits`: 7 days, 1 GiB, 1 MiB per message,
discard-old) and durables redeliver at most `Redelivery::max_deliver` (8)
times. Provisioning creates what is missing and fills in only the limits an
older release left unbounded; what an operator tuned (replicas, storage,
larger limits) is never overwritten.

## Transport profiles (ADR 0132)

The client transport is resolved from the deployment plane
(`OPENSESAME_NATS_*`) or, failing that, a stored *public* policy that can only
name references. Three derived profiles:

| Profile | Meaning |
|---|---|
| `plaintext` | the legacy loopback profile (`ops/nats/local-dev.conf`); no TLS, no credentials; the only profile that provisions on connect |
| `server_tls` | TLS required, server verified against the configured bundle, no client certificate |
| `mtls_required` | TLS required **and** a client certificate presented (`ops/nats/secure-client.conf`, `verify: true`) |

On any TLS profile the client sets `require_tls`, `ignore_discovered_servers`
(an `INFO.connect_urls` entry can never add an egress destination) and
`retain_servers_order`; `OPENSESAME_NATS_TLS_FIRST=1` adds `tls_first` for a
`handshake_first` server. A secure profile that cannot connect becomes
`UnavailableTaskBus` — never memory, never plaintext.

Roles (`NatsRole`) are least privilege and map one-to-one onto the nkey users
in `ops/nats/opensesame-roles.conf` (included by `secure-client.conf`, and by
`secure-callout.conf` where they bypass the callout — mixed mode) plus the
callout user: `provisioner` (the one-time stream/consumer
creation), `host`, `publisher`, `consumer`, `backup`, `callout`. Only the
provisioner may create; every runtime role that finds no durable fails with
`not_provisioned`.

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
cargo +1.88.0 test -p opensesame-task-bus --features jetstream
cargo +1.88.0 test -p opensesame-task-bus --no-default-features

# Real-server suites (pinned nats-server 2.11.17 from scripts/mtls/mtls-fixtures.sh):
# roles, routes, TLS topology, callout expiry, delivery semantics, mixed mode
OPENSESAME_MTLS_FIXTURES=1 \
  cargo +1.88.0 test -p opensesame-task-bus --features live-tests -- --ignored
```

Postgres remains the authoritative Identity outbox (ADR 0010). JetStream is a
drain / Host bus — not a second source of truth.
