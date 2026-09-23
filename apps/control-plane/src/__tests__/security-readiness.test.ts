import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { verifySecurityDatabase } from "../repos/security-readiness.js";

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

// PGlite boot + every migration is setup: in a hook with the 60s budget the
// other PGlite suites use, not inside the 15s test budget (8.6s of it in CI).
beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: new URL(
      "../../../../packages/database/drizzle",
      import.meta.url,
    ).pathname,
  });
}, 60_000);

afterAll(async () => {
  await client.close();
});

it("checks every security store and leaves no readiness record", async () => {
  await verifySecurityDatabase(overlapCast(db));
  expect(await db.select().from(schema.oidcPayloads)).toEqual([]);
  // OIDC still works, but a missing credential store makes readiness fail.
  await db.execute(sql`DROP TABLE ${schema.authenticationCredentials}`);
  expect(await db.select().from(schema.oidcPayloads)).toEqual([]);
  await expect(verifySecurityDatabase(overlapCast(db))).rejects.toThrow();
  expect(await db.select().from(schema.oidcPayloads)).toEqual([]);
});
