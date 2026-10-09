/**
 * A fresh, fully migrated in-process Postgres for each test, without paying
 * for the migrations each time. The first call in a test file boots PGlite,
 * applies every migration in `packages/database/drizzle` and keeps a copy of
 * the data directory; every database after that starts from the copy, which
 * is the state `new PGlite()` plus `migrate` leaves, in a third of the time.
 * Warm it in `beforeAll` so no test's own budget pays for the first one.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const MIGRATIONS = new URL(
  "../../../../packages/database/drizzle",
  import.meta.url,
).pathname;

let template: Promise<Blob> | null = null;

async function migrateTemplate(): Promise<Blob> {
  const client = new PGlite();
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
    return await client.dumpDataDir("none");
  } finally {
    await client.close();
  }
}

/** Migrate the template once per test file; a failure is retried next call. */
export function warmMigratedPGlite(): Promise<Blob> {
  template ??= migrateTemplate().catch((error: Error) => {
    template = null;
    throw error;
  });
  return template;
}

/** A database of its own, every migration applied. Close it when done. */
export async function migratedPGlite(): Promise<PGlite> {
  return new PGlite({ loadDataDir: await warmMigratedPGlite() });
}
