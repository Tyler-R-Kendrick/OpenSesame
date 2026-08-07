# ADR 0031 — SQLite local vs PostgreSQL distributed task store

## Status
Accepted

## Context
Developer and edge deployments need embedded storage; production authority plane requires transactional consistency across workers.

## Decision
**SQLite** backs local-only task-access stores (daemon, credential-agent dev, unit/integration tests via in-memory or file DB). **PostgreSQL** is the authoritative store for distributed task runs, transitions, acks, and credential metadata in gateway/worker deployments. Same domain types; storage trait implementations differ.

Migrations for the distributed task store live under `crates/task-access/migrations/`:

| Migration | Purpose |
|-----------|---------|
| `0001_task_access.sql` | Core tables: `task_runs`, `capability_transitions`, `ack_sets`, `result_buffers`, `task_credentials` |

Gateway readiness exposes `distributed_task_authority: true` only when `OPENSESAME_TASK_DB` points at PostgreSQL and migrations have been applied successfully.

## Consequences
`InMemoryTaskStore` and future `SqliteTaskStore` for local; `PostgresTaskStore` for production. No split-brain: production never uses SQLite as source of truth for shared task state. Compare-and-swap on `task_runs.state_version` fences stale multi-node commits.
