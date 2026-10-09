import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { migrate as migratePostgresJs } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { type Database, PostgresRepositories } from "../src/repos/postgres.js";
import * as schema from "../src/schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "drizzle");

export interface PgTestContext {
  repos: PostgresRepositories;
  db: Database;
  /** Closes the connection and, on a real server, drops the context's database. */
  client: { close(): Promise<void> };
  /** Which engine this context runs on. */
  engine: "pglite" | "postgres-js";
}

/**
 * A fully migrated Postgres wired to the production repositories, with every
 * table/FK/index the repositories rely on.
 *
 * Two engines, one contract. Without `DATABASE_URL` it is an in-process PGlite.
 * With `DATABASE_URL` it is that real server through the production driver
 * (postgres-js), in a database of its own that is dropped afterwards, so the
 * suites are repeatable against a long-lived server and never touch its
 * existing databases. The distinction matters: PGlite binds a JS `Date` that
 * postgres-js cannot, so a raw-SQL fragment with a `Date` parameter passes on
 * one and throws `ERR_INVALID_ARG_TYPE` on the other. Run the suites on both:
 *
 *     pnpm --filter @opensesame/database test                      # PGlite
 *     DATABASE_URL=postgres://… OPENSESAME_CLAIM_PEPPER=… \
 *       pnpm --filter @opensesame/database test:postgres           # real server
 *
 * The role in `DATABASE_URL` needs `CREATEDB`.
 */
export async function createPgTestContext(): Promise<PgTestContext> {
  const url = process.env.DATABASE_URL?.trim();
  return url ? createRealPostgresContext(url) : createPgliteContext();
}

async function createPgliteContext(): Promise<PgTestContext> {
  const client = new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  // SAFETY: drizzle(PGlite) is the same schema-typed Database as postgres-js;
  // the query-result HKT differs, so TypeScript requires the unknown step.
  const database: Database = overlapCast(db);
  return {
    repos: new PostgresRepositories(database),
    db: database,
    client: { close: () => client.close() },
    engine: "pglite",
  };
}

/** The same server and credentials, another database name. */
function withDatabase(url: string, name: string): string {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}

async function createRealPostgresContext(url: string): Promise<PgTestContext> {
  // A database of its own rather than a schema: the migrations name
  // `"public"."principals"` in their foreign keys, so a second schema would
  // point back at the first context's tables.
  const databaseName = `t_${randomUUID().replaceAll("-", "")}`;
  const quiet = { onnotice: () => undefined };
  const admin = postgres(url, { max: 1, ...quiet });
  await admin.unsafe(`create database "${databaseName}"`);
  const sql = postgres(withDatabase(url, databaseName), {
    max: 4,
    prepare: false,
    ...quiet,
  });
  const dropDatabase = async () => {
    await admin.unsafe(
      `drop database if exists "${databaseName}" with (force)`,
    );
    await admin.end({ timeout: 5 });
  };
  const db = drizzlePostgresJs(sql, { schema });
  try {
    await migratePostgresJs(db, { migrationsFolder });
  } catch (error) {
    await sql.end({ timeout: 5 });
    await dropDatabase();
    throw error;
  }
  // SAFETY: the production driver's database, typed by the repositories'
  // alias, which names the same shape through a different HKT.
  const database: Database = overlapCast(db);
  return {
    repos: new PostgresRepositories(database),
    db: database,
    engine: "postgres-js",
    client: {
      close: async () => {
        await sql.end({ timeout: 5 });
        await dropDatabase();
      },
    },
  };
}
