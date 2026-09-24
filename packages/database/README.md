# @opensesame/database

The Identity plane's database: the Drizzle schema for Postgres, the SQL
migrations, and a repository layer with two implementations, Postgres and
in-memory. `createRepositories()` returns the Postgres repositories when a
database URL is set and the in-memory ones otherwise. The Host plane has its
own SQLite store in [`crates/storage`](../../crates/storage).

## Where it fits

- **Used by:** [`packages/control-plane`](../../packages/control-plane) and
  [`packages/identity-worker`](../../packages/identity-worker).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) for the domain types
  the repositories return, `drizzle-orm` and `postgres`.
- Reads `DATABASE_URL` (declared in [`.env.schema`](../../.env.schema)). The
  migrate and reset scripts exit 1 without it; `drizzle.config.ts` falls back
  to `postgres://opensesame:opensesame@127.0.0.1:5432/opensesame`.

## Surface

| Entry | What it holds |
|---|---|
| `@opensesame/database` | `createRepositories`, `createDrizzle`, `createSqlClient`; the `Repositories` interface (principals, authorization requests, interactions, claims, audit events, outbox, webhooks, notification channels and deliveries, approval activations and receipts, wallet registrations, agent auth, `transaction` …); `MemoryRepositories` and `PostgresRepositories`; organization, project, authority-membership, SAML, SCIM, org-federation, OIDC, pairwise-subject, client, consent and authentication-service stores, each with a memory and a Postgres constructor; `ConflictError`, `NotFoundError` |
| `@opensesame/database/schema` | The Drizzle table definitions (`src/schema/index.ts`) |
| `drizzle/` | SQL migrations and `meta/` snapshots, applied in `meta/_journal.json` order |
| `src/migrate.ts`, `src/reset.ts` | `runMigrations(url)` and `resetDatabase(url)`, also run as scripts |

## Develop

```bash
pnpm --filter @opensesame/database test               # PGlite when DATABASE_URL is unset
pnpm --filter @opensesame/database test:integration   # tests/pact.test.ts
pnpm --filter @opensesame/database typecheck
pnpm --filter @opensesame/database db:generate        # drizzle-kit generate from the schema
pnpm --filter @opensesame/database db:migrate         # needs DATABASE_URL
pnpm --filter @opensesame/database db:reset           # drops public + drizzle schemas, re-migrates
```

The root `pnpm db:migrate` / `pnpm db:reset` call the same scripts, and
`pnpm bootstrap` runs `db:generate` then `db:migrate`. Tests use a real
Postgres when `DATABASE_URL` is set and an in-process PGlite otherwise
(`tests/pg-harness.ts`). A migration must land with its `meta/` snapshot:
`tests/migration-journal.test.ts` fails without it, because the next
`db:generate` would re-emit the missing tables.

## Related

- [ADR 0044](../../docs/adr/0044-claimable-connection-delegation.md)
- [`docs/security/audits/2026-08-08-audit-chain-continuity.md`](../../docs/security/audits/2026-08-08-audit-chain-continuity.md)
  — the audit chain's `seq` column
