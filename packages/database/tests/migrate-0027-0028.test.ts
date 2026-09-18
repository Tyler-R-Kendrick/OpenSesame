/**
 * Prove drizzle migrations 0026 (scim_groups) and 0027 (token_endpoint_jwks)
 * actually apply. Production db:migrate still needs DATABASE_URL; this is the
 * same migrator folder against in-process Postgres (PGlite).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "drizzle");

describe("drizzle 0027/0028 migrate", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    await client.waitReady;
    await migrate(drizzle(client), { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  it("creates scim_groups (0027) and oauth_clients.token_endpoint_jwks (0028)", async () => {
    const groups = await client.query<{ t: string | null }>(
      "select to_regclass('public.scim_groups')::text as t",
    );
    expect(groups.rows[0]?.t).toBe("scim_groups");

    const jwks = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public'
         and table_name = 'oauth_clients'
         and column_name = 'token_endpoint_jwks'`,
    );
    expect(jwks.rows.map((r) => r.column_name)).toEqual([
      "token_endpoint_jwks",
    ]);

    const applied = await client.query<{ id: number }>(
      "select id from drizzle.__drizzle_migrations order by created_at",
    );
    expect(applied.rows.length).toBeGreaterThanOrEqual(29);
  });
});
