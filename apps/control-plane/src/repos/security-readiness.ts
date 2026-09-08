import { randomUUID } from "node:crypto";
import { type Database, oidcPayloads } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { and, eq, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

/** Exercise a durable write/read/delete transaction, not merely a DSN check. */
export async function verifySecurityDatabase(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    // Read every declared column without returning data. Missing migrations or
    // inaccessible security stores must not hide behind a healthy OIDC table.
    for (const table of Object.values(schema)) {
      if (is(table, PgTable)) await tx.select().from(table).limit(0);
    }
    const id = randomUUID();
    const model = "OpenSesame:Readiness";
    await tx
      .insert(oidcPayloads)
      .values({ model, id, payload: { healthy: true } });
    const condition = and(
      eq(oidcPayloads.model, model),
      eq(oidcPayloads.id, id),
    );
    const [row] = await tx
      .select({ payload: oidcPayloads.payload })
      .from(oidcPayloads)
      .where(condition);
    if (row?.payload.healthy !== true)
      throw new Error("security_state_unhealthy");
    await tx.delete(oidcPayloads).where(condition);
  });
}
