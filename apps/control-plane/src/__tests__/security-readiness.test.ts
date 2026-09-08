import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { verifySecurityDatabase } from "../repos/security-readiness.js";

it("checks every security store and leaves no readiness record", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: new URL(
        "../../../../packages/database/drizzle",
        import.meta.url,
      ).pathname,
    });
    await verifySecurityDatabase(overlapCast(db));
    expect(await db.select().from(schema.oidcPayloads)).toEqual([]);
    // OIDC still works, but a missing credential store makes readiness fail.
    await db.execute(sql`DROP TABLE ${schema.authenticationCredentials}`);
    expect(await db.select().from(schema.oidcPayloads)).toEqual([]);
    await expect(verifySecurityDatabase(overlapCast(db))).rejects.toThrow();
    expect(await db.select().from(schema.oidcPayloads)).toEqual([]);
  } finally {
    await client.close();
  }
});
