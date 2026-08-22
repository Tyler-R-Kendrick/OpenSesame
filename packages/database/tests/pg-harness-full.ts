import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type Database, PostgresRepositories } from "../src/repos/postgres.js";
import * as schema from "../src/schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface PgTestContext {
  repos: PostgresRepositories;
  db: Database;
  client: PGlite;
}

/**
 * A fully migrated in-process Postgres (PGlite) wired to the production
 * repositories. Unlike `pg-harness.ts` (which only creates the outbox table),
 * this applies the real drizzle migrations so every table/FK/index the
 * repositories rely on behaves exactly as in production.
 */
export async function createPgTestContext(): Promise<PgTestContext> {
  const client = new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: join(here, "..", "drizzle") });
  // SAFETY: drizzle(PGlite) is the same schema-typed Database as postgres-js;
  // the query-result HKT differs, so TypeScript requires the unknown step.
  const database: Database = overlapCast(db);
  return { repos: new PostgresRepositories(database), db: database, client };
}
