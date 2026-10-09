import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createEventSealer, eventSealSecret } from "./event-seal.js";
import type { Repositories } from "./repos/interfaces.js";
import { MemoryRepositories } from "./repos/memory.js";
import { PostgresRepositories } from "./repos/postgres.js";
import { withSealedEvents } from "./repos/sealed-events.js";
import { withSealedSecrets } from "./repos/sealed-secrets.js";
import * as schema from "./schema/index.js";

export function createSqlClient(databaseUrl: string) {
  return postgres(databaseUrl, { max: 10, prepare: false });
}

export function createDrizzle(databaseUrl: string) {
  const sql = createSqlClient(databaseUrl);
  const db = drizzle(sql, { schema });
  return { sql, db };
}

/**
 * Prefer Postgres when DATABASE_URL is set; otherwise in-memory repos for tests/local.
 */
export function createRepositories(options?: {
  databaseUrl?: string;
  /** What event rows are sealed under; defaults to the environment's. */
  eventSealSecret?: string;
}): Repositories {
  const url = options?.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    const { db } = createDrizzle(url);
    // Event rows rest sealed (ADR 0157). No secret, no repositories: a database
    // with nothing to seal its events under refuses rather than store them
    // in the clear.
    const secret = options?.eventSealSecret ?? eventSealSecret(process.env);
    if (secret === undefined) {
      throw new Error(
        "OPENSESAME_EVENT_KEY or OPENSESAME_CLAIM_PEPPER must be set when a database is configured: audit, outbox and delivery payloads are sealed at rest",
      );
    }
    return withSealedEvents(
      withSealedSecrets(
        new PostgresRepositories(db),
        createEventSealer(secret),
      ),
      createEventSealer(secret),
    );
  }
  return new MemoryRepositories();
}
