# ADR 0042: NATS TaskBus, auth callout, and xkeys

## Status

Accepted

## Context

ADR 0002 chose NATS JetStream behind TaskBus. Today `crates/task-bus` only
implements `InMemoryTaskBus`; Compose already runs `nats:2.11.4` with `-js`,
but gateway/worker do not wire a client. Identity already has a Postgres
outbox (ADR 0010) that must remain authoritative. Operators also need
zero-trust bus admission (NATS auth callout) and E2EE bus payloads without
confusing the Host deployment seal key for client-held crypto.

Dual-plane separation (ADR 0017 / 0007) forbids putting the callout on the
Identity API as a BFF, or letting callout decrypt human vault material.

## Decision

1. **JetStream behind `TaskBus`.** Implement a NATS JetStream adapter for
   `publish` / `drain` of CloudEvents-shaped `BusEvent`s. Default to in-memory
   for unit tests; use NATS when `NATS_URL` (or equivalent) is set. Stream /
   subject namespace: `opensesame.events.>` with durable consumer
   `opensesame-worker` (configurable); leave room for `opensesame.callout.>`.
2. **Host serves NATS auth callout.** Gateway (`:8787`) answers authorization
   requests with allow/deny + permissions using Host authz (OpenFGA / AuthZEN).
   Identity (`:8788`) validates tokens and resolves principal mapping only —
   never the callout decision surface.
3. **Mixed-mode admission without email join.** Multiple upstream IdPs map to
   canonical principals via `PrincipalMappingStore` / pairwise subjects
   (ADR 0011). Email auto-link remains off.
4. **xkeys for E2EE payloads.** Seal bus/sensitive payloads with X25519 /
   age-lineage recipient keys plus human-vault-style AEAD. The Host
   `OPENSESAME_CONNECTION_KEY` / deployment seal key is **never** used as
   xkey material (fake E2EE forbidden).
5. **Outbox → bus drain.** Identity mutations continue to write the Postgres
   outbox first; workers publish to TaskBus and mark published. JetStream is a
   drain / Host bus, not a second source of truth (ADR 0010).

## Consequences

- Sync, rotation, and changelog producers emit bus events through the TaskBus
  trait (in-memory in tests; JetStream in compose/deploy).
- No Identity BFF callout; provisional principals stay minimally privileged on
  the bus.
- Public NATS subjects/headers prefer pairwise or opaque capability tokens —
  not canonical principal IDs.
- Operator wiring is documented in
  [docs/architecture/task-bus-nats.md](../architecture/task-bus-nats.md) and
  [docs/operators/local.md](../operators/local.md).

## Related

- [ADR 0002](0002-foundations.md)
- [ADR 0010](0010-postgres-authoritative-store.md)
- [ADR 0011](0011-pairwise-subject-storage.md)
- [ADR 0017](0017-host-client-product-topology.md)
- [ADR 0032](0032-connection-broker-service-integrations.md)
- [ADR 0041](0041-projects-sync-targets-and-secret-changelog.md)
- [Architecture: TaskBus / NATS](../architecture/task-bus-nats.md)
