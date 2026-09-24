# opensesame-task-access

The Trust Ratchet task-access engine for the Host / authority plane. A task run
starts under an immutable capability ceiling, and its capabilities may only
shrink: a restriction is proposed, acknowledged by each enforcement point, and
committed, and protected results stay buffered until the acknowledgements are
in. The engine stores task runs, transitions, acknowledgements and credential
metadata behind one `TaskStore` trait with SQLite and PostgreSQL
implementations.

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway) (`src/task_engine.rs`,
  `src/routes/tasks.rs`) and [`opensesame-broker`](../broker)
  (`src/frozen.rs`).
- **Builds on:** [`opensesame-domain`](../domain) (task and capability types);
  `sqlx` for both stores.
- No widen operation exists. Credential records hold a digest, never raw
  secret material.
- SQLite is for local, single-node authority; distributed Host deployments use
  PostgreSQL (`distributed_task_authority_ok` is true only for a migrated
  Postgres backend).

## Surface

| Item | Role |
|---|---|
| `TaskAccessEngine` | `compile_ceiling`, `start_task`, `assert_ceiling_unchanged`, `assert_capability`, `propose_restriction`, `acknowledge`, `commit_transition`, `release_result_buffer`, `renew_credential`, `assert_authority_context_unchanged`, `terminate_task`, `list_runs` |
| `TaskStore` | Persistence trait with compare-and-set fencing on the state version |
| `InMemoryTaskStore`, `SharedTaskStore` | In-process stores for tests and single-process use |
| `SqliteTaskStore` | `connect`, `connect_memory`, `migrate`; embeds `migrations/0001_task_access_sqlite.sql` |
| `PostgresTaskStore`, `PostgresTaskAuthorityConfig` | Distributed store; embeds `migrations/0001_task_access.sql` |
| `TaskAuthorityBackend`, `task_authority_backend_from_url`, `is_postgres_database_url` | Pick a backend from a database URL |
| `TaskCredentialRecord`, `ProtectedResultBuffer` | Credential metadata and buffered results |
| `TaskAccessError` | Error type |

| Cargo feature | Effect |
|---|---|
| `postgres-integration` | Compiles the live Postgres CAS test; needs `OPENSESAME_TEST_DATABASE_URL` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-task-access
OPENSESAME_TEST_DATABASE_URL=postgres://… \
  cargo +1.88.0 test -p opensesame-task-access --features postgres-integration
pnpm test:task-access
```

The SQL schemas live in [`migrations/`](migrations), one per backend; change
both together.

## Related

- [ADR 0020](../../docs/adr/0020-trust-ratchet.md) — trust ratchet for task capabilities
- [ADR 0031](../../docs/adr/0031-sqlite-local-vs-postgres-distributed.md) — SQLite local vs Postgres distributed
- [ADR 0019](../../docs/adr/0019-immutable-ceiling.md) — immutable ceiling
- [ADR 0021](../../docs/adr/0021-frozen-intent.md) — frozen intent
