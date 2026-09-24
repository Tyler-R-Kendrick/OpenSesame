# opensesame-storage

The Host database. `Db` wraps a SQLx `SqlitePool`, applies the embedded
migrations in [`migrations/`](migrations) on connect, and is the only writer of
the Host's tables: connections, grants and invocations, generalized authority
and its fences, the certificate manager, approvals, sync and backup, shared
sessions, agent runs and the security-event feed. Its one `impl Db` is split
across one module per responsibility.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway),
  [`apps/cli`](../../apps/cli),
  [`opensesame-broker`](../broker), [`opensesame-connection-broker`](../connection-broker)
  (dev-dependency), the fuzz crate [`tests/fuzz/cargo`](../../tests/fuzz/cargo)
  (`certmgr_filter_parse`), and the authority-fabric gate
  (`pnpm test:authority-fabric`).
- **Builds on:** [`opensesame-domain`](../domain) (records and IDs) and
  [`opensesame-lifecycle`](../lifecycle) (the watermark and fence vocabulary).
- A realm (`organization_id`) is part of every authority key and predicate, and
  a security mutation writes its outbox event in the same transaction.
- Migrations are append-only: an applied version is never rewritten.

## Surface

| Area | Modules |
|---|---|
| Connect and migrate | `Db::connect_sqlite`, `Db::connect_memory`, `Db::migrate`, `migration_versions`, `sqlite_file_url`, `Store` |
| Connections and grants | `connections`, `grants`, `invocations`, `host_authorizations`, `host_kv`, `tenancy` |
| Generalized authority | `authority/` (grants, offers, budgets, effects, projection, restore), `authority_fence/` (ADR 0121) |
| Certificate manager | `cert_authorities`, `cert_issuance`, `cert_inventory`, `cert_policy`, `cert_alerts`, `managed_certs`, `renewal`, `revocation`, `acme`, `est_scep`, `enrollment`, `external_ca`, `signing`, `signing_access`, `discovery` |
| Approvals | `approval_policies`, `approval_requests` |
| Sync, outbox, backup | `sync`, `sync_pages`, `sync_write`, `sync_rebind`, `outbox`, `backup_inventory`, `vault_backup` |
| Sessions and agent runs | `shared_sessions/`, `browser_pairing`, `observation`, `runner_steps`, `a2h_replies`, `agent_capabilities`, `callback_replay` |
| Security feed | `security` (hooks, deliveries, breach findings, lifecycle watermarks) |

Row types are the `Stored*` structs exported from [`src/lib.rs`](src/lib.rs).

## Develop

```bash
cargo +1.88.0 test -p opensesame-storage
pnpm test:mutation:rust   # src/lib.rs is in the mutation scope
```

A schema change is a new file `migrations/NNNN_<name>.sql` plus an entry
appended to `MIGRATIONS` in [`src/migrations.rs`](src/migrations.rs); never
edit an applied one. `src/migration_upgrade_tests.rs` checks that an upgrade
preserves the previous journal and rolls back failed DDL.

New methods go in the module for their responsibility, not in `lib.rs`.
`lib.rs` (2,091 lines) and a few modules carry recorded numbers in
[`tools/quality/quality-baseline.json`](../../tools/quality/quality-baseline.json)
that may only fall; new files meet the 400-line budget outright
(`pnpm quality:gate`). The `insta` snapshots in
[`tests/snapshots`](tests/snapshots) pin certificate-manager wire shapes.

## Related

- [ADR 0093](../../docs/adr/0093-structural-quality-gates.md) — structural quality gates (the `impl Db` split)
- [ADR 0121](../../docs/adr/0121-durable-authority-invalidation-fencing.md) — durable authority invalidation fencing
- [ADR 0066](../../docs/adr/0066-certificate-manager-domain-model.md) — certificate manager domain model
- [ADR 0080](../../docs/adr/0080-security-event-hooks.md) — security-event hooks
- [`docs/architecture/general-authority.md`](../../docs/architecture/general-authority.md)
