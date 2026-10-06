import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { EventSealError, type EventSealer } from "../event-seal.js";
import { betterAuthSessions } from "../schema/index.js";
import { openSecretText, sealSecretText } from "../secret-seal.js";
import type { Database } from "./postgres.js";

/** Replace legacy session bearers with keyed indexes and customer-bound token envelopes. */
export async function sealLegacySessions(
  db: Database,
  sealer: EventSealer,
  allowLegacy = true,
): Promise<number> {
  let cursor = "";
  let changed = 0;
  for (;;) {
    const rows = await db
      .select({
        id: sql<string>`id`,
        token: sql<string>`token`,
        userId: sql<string>`user_id`,
        sealedToken: sql<string | null>`sealed_token`,
      })
      .from(sql`better_auth_sessions`)
      .where(sql`id > ${cursor}`)
      .orderBy(sql`id`)
      .limit(200);
    if (rows.length === 0) return changed;
    for (const row of rows) {
      cursor = row.id;
      const purpose = (digest: string) =>
        JSON.stringify(["better_auth_sessions", digest, "token"]);
      if (row.sealedToken !== null) {
        const marker: BoundaryValue = JSON.parse(row.sealedToken);
        if (
          !isJsonObject(marker) ||
          !sealer.isSealed(marker) ||
          !isString(marker.$sealed) ||
          !marker.$sealed.startsWith("osev2.")
        )
          throw new EventSealError("better_auth_sessions.token");
        const plain = openSecretText(
          sealer,
          purpose(row.token),
          row.userId,
          row.sealedToken,
        );
        if (
          sealer.lookupToken("better_auth_sessions.token", plain) !== row.token
        )
          throw new Error("Session token index authentication failed");
        continue;
      }
      if (!allowLegacy) throw new EventSealError("better_auth_sessions.token");
      const digest = sealer.lookupToken(
        "better_auth_sessions.token",
        row.token,
      );
      const envelope = sealSecretText(
        sealer,
        purpose(digest),
        row.userId,
        row.token,
      );
      const updated = await db
        .update(betterAuthSessions)
        .set({ token: digest, sealedToken: envelope })
        .where(
          and(
            eq(betterAuthSessions.id, row.id),
            eq(betterAuthSessions.token, row.token),
            eq(betterAuthSessions.userId, row.userId),
            isNull(betterAuthSessions.sealedToken),
          ),
        )
        .returning({ id: betterAuthSessions.id });
      changed += updated.length;
    }
  }
}
