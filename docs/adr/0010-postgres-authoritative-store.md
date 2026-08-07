# ADR 0010 — PostgreSQL as authoritative identity store

## Status
Accepted

## Decision
PostgreSQL is the sole authoritative store for identity-plane principals, claims, pairwise subjects, OIDC provider adapter state, idempotency keys, and transactional outbox/job backing. No Redis/Kafka/mesh for this slice.

## Consequences
Drizzle migrations + memory repos for unit tests; Testcontainers for integration when Docker is available.
