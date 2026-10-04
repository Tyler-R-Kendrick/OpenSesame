import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import * as schema from "../schema/index.js";
import {
  ConflictError,
  type PushSubscription,
  type PushSubscriptionRepository,
  type UnitOfWork,
} from "./interfaces.js";
import type { Database } from "./postgres.js";

function mapPushSubscription(
  row: typeof schema.pushSubscriptions.$inferSelect,
): PushSubscription {
  return {
    id: row.id,
    principalId: row.principalId,
    endpoint: row.endpoint,
    p256dhKey: row.p256dhKey,
    authSecret: row.authSecret,
    endpointDigest: row.endpointDigest,
    ...(row.deviceLabel ? { deviceLabel: row.deviceLabel } : undefined),
    createdAt: row.createdAt,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : undefined),
    ...(row.disabledAt ? { disabledAt: row.disabledAt } : undefined),
  };
}

/**
 * Upsert onto `endpoint_digest`, not a plain insert. A browser that
 * re-subscribes presents the same endpoint, and the same endpoint is the same
 * destination: the stored keys are replaced in place — the row keeps its id and
 * `created_at`, and a disabled row is revived — so the table can never hold two
 * rows that push the same person.
 *
 * The endpoint is a capability URL, so the row's owner is part of what it
 * protects: the update applies only to the owner's own row, or to one its owner
 * already retired. Another principal presenting a live endpoint matches no row,
 * `returning` is empty, and the caller is told — it does not read as a
 * re-subscription and it never moves the row.
 */
async function register(
  db: Database,
  sub: PushSubscription,
): Promise<PushSubscription> {
  const [row] = await db
    .insert(schema.pushSubscriptions)
    .values({
      id: sub.id,
      principalId: sub.principalId,
      endpoint: sub.endpoint,
      p256dhKey: sub.p256dhKey,
      authSecret: sub.authSecret,
      endpointDigest: sub.endpointDigest,
      deviceLabel: sub.deviceLabel ?? null,
      createdAt: sub.createdAt,
      lastUsedAt: sub.lastUsedAt ?? null,
      disabledAt: sub.disabledAt ?? null,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpointDigest,
      set: {
        principalId: sub.principalId,
        endpoint: sub.endpoint,
        p256dhKey: sub.p256dhKey,
        authSecret: sub.authSecret,
        deviceLabel: sub.deviceLabel ?? null,
        lastUsedAt: sub.lastUsedAt ?? null,
        disabledAt: sub.disabledAt ?? null,
      },
      setWhere: sql`${eq(schema.pushSubscriptions.principalId, sub.principalId)} or ${isNotNull(schema.pushSubscriptions.disabledAt)}`,
    })
    .returning();
  if (!row) {
    throw new ConflictError("push endpoint is registered to another principal");
  }
  return mapPushSubscription(row);
}

/**
 * Compare-and-set on `disabled_at is null`: only the real retirer is told. With
 * a principal the owner is part of the same statement, so a caller cannot
 * retire a row that changed hands between their ownership check and this write
 * (a freed endpoint re-registered by someone else).
 */
async function disable(
  db: Database,
  id: string,
  at: Date,
  principalId?: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.pushSubscriptions)
    .set({ disabledAt: at })
    .where(
      and(
        eq(schema.pushSubscriptions.id, id),
        isNull(schema.pushSubscriptions.disabledAt),
        principalId === undefined
          ? undefined
          : eq(schema.pushSubscriptions.principalId, principalId),
      ),
    )
    .returning({ id: schema.pushSubscriptions.id });
  return rows.length === 1;
}

/** Postgres rows behind the `PushSubscriptionRepository` interface. */
export function createPostgresPushSubscriptions(
  db: Database,
  dbOf: (uow: UnitOfWork | undefined) => Database,
): PushSubscriptionRepository {
  const one = async (where: ReturnType<typeof eq>) => {
    const [row] = await db
      .select()
      .from(schema.pushSubscriptions)
      .where(where)
      .limit(1);
    return row ? mapPushSubscription(row) : null;
  };
  return {
    create: (sub, uow) => register(dbOf(uow), sub),

    listForPrincipal: async (principalId) => {
      const rows = await db
        .select()
        .from(schema.pushSubscriptions)
        .where(
          and(
            eq(schema.pushSubscriptions.principalId, principalId),
            // A disabled subscription is not a destination.
            isNull(schema.pushSubscriptions.disabledAt),
          ),
        )
        .orderBy(asc(schema.pushSubscriptions.createdAt));
      return rows.map(mapPushSubscription);
    },

    getById: (id) => one(eq(schema.pushSubscriptions.id, id)),

    findByEndpointDigest: (digest) =>
      one(eq(schema.pushSubscriptions.endpointDigest, digest)),

    disable: (id, at, principalId) => disable(db, id, at, principalId),
  };
}
