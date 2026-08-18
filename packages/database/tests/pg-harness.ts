import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { createDrizzle } from "../src/client.js";
import type { Repositories } from "../src/repos/interfaces.js";
import {
  PostgresRepositories,
  type Database,
} from "../src/repos/postgres.js";
import * as schema from "../src/schema/index.js";

/** Subset of 0000_brave_sally_floyd.sql needed for outbox SKIP LOCKED. */
const OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" text PRIMARY KEY NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text
);
`;

/**
 * Run `fn` against the Postgres outbox implementation. Uses DATABASE_URL when
 * set (real server, already migrated); otherwise an in-process PGlite so SKIP
 * LOCKED is always exercised — never skipped.
 */
export async function withPostgresRepos<T>(
  fn: (repos: Repositories) => Promise<T>,
): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { sql, db } = createDrizzle(url);
    try {
      return await fn(new PostgresRepositories(db));
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  const client = new PGlite();
  await client.waitReady;
  await client.exec(OUTBOX_DDL);
  const db = drizzlePglite(client, { schema });
  try {
    return await fn(new PostgresRepositories(db as unknown as Database));
  } finally {
    await client.close();
  }
}
