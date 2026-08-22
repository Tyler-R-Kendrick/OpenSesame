import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { and, eq, lt } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

/**
 * Payload shape the oidc-provider adapter stores.
 *
 * Kept structural rather than importing `oidc-provider` here: this package has no
 * business depending on the issuer, and `packages/oauth-provider` already owns
 * that contract.
 */
export interface OidcStorePayload extends Record<string, unknown> {
  uid?: string;
  userCode?: string;
  grantId?: string;
  consumed?: unknown;
}

export interface OidcStore {
  upsert(
    model: string,
    id: string,
    payload: OidcStorePayload,
    expiresAt: Date | null,
  ): Promise<void>;
  find(model: string, id: string): Promise<OidcStorePayload | undefined>;
  findByUserCode(
    model: string,
    userCode: string,
  ): Promise<OidcStorePayload | undefined>;
  findByUid(model: string, uid: string): Promise<OidcStorePayload | undefined>;
  destroy(model: string, id: string): Promise<void>;
  consume(model: string, id: string): Promise<void>;
  revokeByGrantId(grantId: string): Promise<void>;
  /** Drop rows whose TTL has passed. Returns how many were removed. */
  pruneExpired(now?: Date): Promise<number>;
}

/**
 * Postgres persistence for the issuer's own models — sessions, authorization
 * codes, refresh tokens, device flows, grants.
 *
 * Two things matter beyond storing bytes. An expired row is never returned, so a
 * token that outlived its TTL is not honoured merely because no cleanup has run
 * yet. And `consume` stamps the row rather than deleting it, because the provider
 * decides what a replayed authorization code means: it has to see a consumed
 * code, not a missing one.
 */
/** A stored row, as far as the payload rules care. */
export interface OidcRow {
  payload: JsonObject;
  expiresAt: Date | null;
  consumedAt: Date | null;
}

/**
 * The row a payload is stored as.
 *
 * The lookup keys are lifted out of the payload rather than trusted from a
 * caller, and only when they are strings: `findByUid` and `findByUserCode` are
 * how a device flow and an interaction find their own record, so a non-string
 * there would become a row nothing can look up.
 */
export function oidcRowValues(
  model: string,
  id: string,
  payload: OidcStorePayload,
  expiresAt: Date | null,
) {
  const storedPayload: JsonObject = overlapCast(payload);
  return {
    model,
    id,
    payload: storedPayload,
    expiresAt,
    uid: isString(payload.uid) ? payload.uid : null,
    userCode: isString(payload.userCode) ? payload.userCode : null,
    grantId: isString(payload.grantId) ? payload.grantId : null,
  };
}

/**
 * What a read hands back, or nothing.
 *
 * An expired row is never returned: a token that outlived its TTL must not be
 * honoured because no cleanup has run yet. A consumed row is returned *with* the
 * `consumed` stamp, because the provider decides what a replayed authorization
 * code means and needs to see a consumed code rather than a missing one.
 */
export function oidcPayloadFromRow(
  row: OidcRow,
  now: Date = new Date(),
): OidcStorePayload | undefined {
  if (row.expiresAt && row.expiresAt <= now) return undefined;
  const payload: OidcStorePayload = overlapCast({ ...row.payload });
  if (row.consumedAt) {
    payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
  }
  return payload;
}

export function createPostgresOidcStore(db: Database): OidcStore {
  const rowFor = (model: string, id: string) =>
    and(eq(schema.oidcPayloads.model, model), eq(schema.oidcPayloads.id, id));

  const live = (row: OidcRow): OidcStorePayload | undefined =>
    oidcPayloadFromRow(row);

  return {
    async upsert(model, id, payload, expiresAt) {
      const values = oidcRowValues(model, id, payload, expiresAt);
      await db
        .insert(schema.oidcPayloads)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.oidcPayloads.model, schema.oidcPayloads.id],
          set: {
            payload: values.payload,
            expiresAt: values.expiresAt,
            uid: values.uid,
            userCode: values.userCode,
            grantId: values.grantId,
          },
        });
    },

    async find(model, id) {
      const [row] = await db
        .select()
        .from(schema.oidcPayloads)
        .where(rowFor(model, id))
        .limit(1);
      return row ? live(row) : undefined;
    },

    async findByUserCode(model, userCode) {
      const [row] = await db
        .select()
        .from(schema.oidcPayloads)
        .where(
          and(
            eq(schema.oidcPayloads.model, model),
            eq(schema.oidcPayloads.userCode, userCode),
          ),
        )
        .limit(1);
      return row ? live(row) : undefined;
    },

    async findByUid(model, uid) {
      const [row] = await db
        .select()
        .from(schema.oidcPayloads)
        .where(
          and(
            eq(schema.oidcPayloads.model, model),
            eq(schema.oidcPayloads.uid, uid),
          ),
        )
        .limit(1);
      return row ? live(row) : undefined;
    },

    async destroy(model, id) {
      await db.delete(schema.oidcPayloads).where(rowFor(model, id));
    },

    async consume(model, id) {
      await db
        .update(schema.oidcPayloads)
        .set({ consumedAt: new Date() })
        .where(rowFor(model, id));
    },

    async revokeByGrantId(grantId) {
      await db
        .delete(schema.oidcPayloads)
        .where(eq(schema.oidcPayloads.grantId, grantId));
    },

    async pruneExpired(now = new Date()) {
      // Rows with no TTL are the provider's long-lived models; they stay.
      const removed = await db
        .delete(schema.oidcPayloads)
        .where(lt(schema.oidcPayloads.expiresAt, now))
        .returning({ id: schema.oidcPayloads.id });
      return removed.length;
    },
  };
}
