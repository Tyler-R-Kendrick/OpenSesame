import { and, eq, sql } from "drizzle-orm";
import { EventSealError, type EventSealer } from "../event-seal.js";
import { scopeLegacyInternalPayload } from "../oidc-internal-scope.js";
import { openOidcRow, sealOidcRow } from "../oidc-seal.js";
import * as schema from "../schema/index.js";
import type { Database } from "./postgres.js";

/** Atomically replace legacy issuer bearers and their payload with envelope/index storage. */
export async function sealLegacyOidc(
  db: Database,
  sealer: EventSealer,
  allowLegacy = true,
): Promise<number> {
  let cursorModel = "";
  let cursorId = "";
  let changed = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(schema.oidcPayloads)
      .where(
        sql`(${schema.oidcPayloads.model}, ${schema.oidcPayloads.id}) > (${cursorModel}, ${cursorId})`,
      )
      .orderBy(schema.oidcPayloads.model, schema.oidcPayloads.id)
      .limit(200);
    if (rows.length === 0) return changed;
    for (const row of rows) {
      cursorModel = row.model;
      cursorId = row.id;
      if (row.sealScope !== null) {
        openOidcRow(sealer, row);
        continue;
      }
      if (!allowLegacy) throw new EventSealError("oidc_payloads.payload");
      if ("$sealed" in row.payload)
        throw new EventSealError("oidc_payloads.legacy");
      const values = sealOidcRow(
        sealer,
        row.model,
        row.id,
        scopeLegacyInternalPayload(row.model, row.id, row.payload),
      );
      // One UPDATE reindexes the primary key with all indexes and ciphertext.
      // A concurrent writer or migration wins without losing its newer value.
      const updated = await db
        .update(schema.oidcPayloads)
        .set(values)
        .where(
          and(
            eq(schema.oidcPayloads.model, row.model),
            eq(schema.oidcPayloads.id, row.id),
            sql`${schema.oidcPayloads.payload} = ${JSON.stringify(row.payload)}::jsonb`,
            sql`${schema.oidcPayloads.sealScope} is null`,
          ),
        )
        .returning({ id: schema.oidcPayloads.id });
      changed += updated.length;
    }
  }
}
