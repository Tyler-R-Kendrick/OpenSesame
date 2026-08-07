import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";
import { MemoryRepositories } from "./repos/memory.js";
import { PostgresRepositories, type Database } from "./repos/postgres.js";
import type { Repositories } from "./repos/interfaces.js";

export function createSqlClient(databaseUrl: string) {
  return postgres(databaseUrl, { max: 10, prepare: false });
}

export function createDrizzle(databaseUrl: string): {
  sql: ReturnType<typeof postgres>;
  db: Database;
} {
  const sql = createSqlClient(databaseUrl);
  const db = drizzle(sql, { schema });
  return { sql, db };
}

/**
 * Prefer Postgres when DATABASE_URL is set; otherwise in-memory repos for tests/local.
 */
export function createRepositories(options?: {
  databaseUrl?: string;
}): Repositories {
  const url = options?.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    const { db } = createDrizzle(url);
    return new PostgresRepositories(db);
  }
  return new MemoryRepositories();
}
