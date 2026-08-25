import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

/**
 * Server-side pending state for SP-initiated SAML (ADR 0056).
 *
 * A cookie cannot hold this: the ACS receives a cross-site POST that carries
 * no `SameSite=Lax` cookies, and a multi-KB assertion cannot be
 * re-materialized into a GET the way Apple's `form_post` can. The response is
 * matched on `InResponseTo`, so the request id is the key and the read is
 * single-use — a second response quoting the same id finds nothing.
 */
export interface SamlPendingRecord {
  requestId: string;
  interactionUid: string;
  organizationId: string;
  createdAt: Date;
}

export interface SamlPendingStore {
  put(pending: SamlPendingRecord): Promise<void>;
  /** Single-use: the row is consumed by the read that finds it. */
  take(requestId: string): Promise<Omit<SamlPendingRecord, "requestId"> | null>;
}

/**
 * Assertion ids already consumed. IdP-initiated sign-in has no request to bind
 * to, so replay is refused here instead. `seen` records on first sight and
 * answers true from the second onwards, for as long as the assertion could
 * still be considered valid.
 */
export interface SamlReplayCache {
  seen(assertionId: string, expiresAt: Date): Promise<boolean>;
}

export interface SamlStores {
  pending: SamlPendingStore;
  replay: SamlReplayCache;
}

/**
 * How long an unanswered SP-initiated request stays takeable. Longer than any
 * human sign-in, short enough that abandoned rows do not accumulate.
 */
export const SAML_PENDING_TTL_MS = 15 * 60 * 1000;

export function createMemorySamlStores(): SamlStores {
  const pending = new Map<string, SamlPendingRecord>();
  const replay = new Map<string, Date>();

  const prunePending = (now: Date) => {
    for (const [requestId, row] of pending) {
      if (now.getTime() - row.createdAt.getTime() > SAML_PENDING_TTL_MS) {
        pending.delete(requestId);
      }
    }
  };

  const pruneReplay = (now: Date) => {
    for (const [assertionId, expiresAt] of replay) {
      if (expiresAt <= now) replay.delete(assertionId);
    }
  };

  return {
    pending: {
      async put(record) {
        prunePending(record.createdAt);
        pending.set(record.requestId, { ...record });
      },

      async take(requestId) {
        prunePending(new Date());
        const row = pending.get(requestId);
        if (!row) return null;
        pending.delete(requestId);
        return {
          interactionUid: row.interactionUid,
          organizationId: row.organizationId,
          createdAt: row.createdAt,
        };
      },
    },

    replay: {
      async seen(assertionId, expiresAt) {
        const now = new Date();
        pruneReplay(now);
        if (replay.has(assertionId)) return true;
        replay.set(assertionId, expiresAt);
        return false;
      },
    },
  };
}

export function createPostgresSamlStores(db: Database): SamlStores {
  return {
    pending: {
      async put(record) {
        // Prune on write: an abandoned request is never read, so nothing else
        // would ever clear it.
        await db
          .delete(schema.samlPending)
          .where(
            lt(
              schema.samlPending.createdAt,
              new Date(record.createdAt.getTime() - SAML_PENDING_TTL_MS),
            ),
          );
        await db
          .insert(schema.samlPending)
          .values({
            requestId: record.requestId,
            interactionUid: record.interactionUid,
            organizationId: record.organizationId,
            createdAt: record.createdAt,
          })
          .onConflictDoUpdate({
            target: schema.samlPending.requestId,
            set: {
              interactionUid: record.interactionUid,
              organizationId: record.organizationId,
              createdAt: record.createdAt,
            },
          });
      },

      async take(requestId) {
        // DELETE ... RETURNING is the single-use read: two responses quoting
        // the same InResponseTo cannot both be answered.
        const [row] = await db
          .delete(schema.samlPending)
          .where(eq(schema.samlPending.requestId, requestId))
          .returning();
        if (!row) return null;
        const cutoff = Date.now() - SAML_PENDING_TTL_MS;
        if (row.createdAt.getTime() < cutoff) return null;
        return {
          interactionUid: row.interactionUid,
          organizationId: row.organizationId,
          createdAt: row.createdAt,
        };
      },
    },

    replay: {
      async seen(assertionId, expiresAt) {
        const now = new Date();
        await db
          .delete(schema.samlAssertionReplay)
          .where(lt(schema.samlAssertionReplay.expiresAt, now));
        // Insert-or-nothing: the primary key decides the race, so two
        // concurrent posts of one assertion cannot both be first.
        const inserted = await db
          .insert(schema.samlAssertionReplay)
          .values({ assertionId, expiresAt, seenAt: now })
          .onConflictDoNothing()
          .returning({ assertionId: schema.samlAssertionReplay.assertionId });
        if (inserted.length > 0) return false;
        // A row survives only while it could still be replayed; an expired one
        // was already pruned above, so anything left is a genuine replay.
        const [existing] = await db
          .select()
          .from(schema.samlAssertionReplay)
          .where(
            and(
              eq(schema.samlAssertionReplay.assertionId, assertionId),
              sql`${schema.samlAssertionReplay.expiresAt} >= ${now}`,
            ),
          )
          .limit(1);
        return existing !== undefined;
      },
    },
  };
}
