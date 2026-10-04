import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import * as schema from "../schema/index.js";
import type { Database } from "./postgres.js";

/**
 * How long a claimed delivery belongs to its claimer.
 *
 * A claim bumps `attempts` and pushes `next_attempt_at` this far out, so a
 * second dispatcher (another replica, or the next tick after a slow one) does
 * not see the row as due and send it again while the first is still working on
 * it. Success, failure and dead-lettering all write `next_attempt_at` or a
 * terminal state themselves, so the lease only ever matters for a claimer that
 * died: its row becomes due again when the lease runs out, having burned the one
 * attempt the claim counted.
 *
 * It must outlast one whole dispatch pass: `ceil(limit / concurrency) *
 * deadline` for the worker's defaults (50 rows, 8 at a time, 20 s each, about
 * 140 s), with room to spare. The worker's tests assert that relation.
 */
export const DELIVERY_LEASE_MS = 5 * 60 * 1000;

/** The lease a claim taken at `now` holds until. */
export function leaseUntil(now: Date): Date {
  return new Date(now.getTime() + DELIVERY_LEASE_MS);
}

/**
 * `FOR UPDATE SKIP LOCKED` over the due set, so two dispatchers racing split it
 * instead of double-delivering it; each claimed row has its attempt counted and
 * its lease taken in the same transaction, so a crash mid-send still burned a
 * try and a live send is not claimed again.
 */
export async function claimDueWebhookRows(
  db: Database,
  limit: number,
  now: Date,
) {
  return db.transaction(async (tx) => {
    const t = schema.webhookDeliveries;
    const candidates = await tx
      .select()
      .from(t)
      .where(
        and(isNull(t.deliveredAt), isNull(t.deadAt), lte(t.nextAttemptAt, now)),
      )
      .orderBy(t.nextAttemptAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed: (typeof t.$inferSelect)[] = [];
    for (const row of candidates) {
      const [updated] = await tx
        .update(t)
        .set({ attempts: row.attempts + 1, nextAttemptAt: leaseUntil(now) })
        .where(eq(t.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function claimDueNotificationRows(
  db: Database,
  limit: number,
  now: Date,
) {
  return db.transaction(async (tx) => {
    const t = schema.notificationDeliveries;
    const candidates = await tx
      .select()
      .from(t)
      .where(
        and(
          or(eq(t.state, "pending"), eq(t.state, "failed")),
          lte(t.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(t.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed: (typeof t.$inferSelect)[] = [];
    for (const row of candidates) {
      const [updated] = await tx
        .update(t)
        .set({ attempts: row.attempts + 1, nextAttemptAt: leaseUntil(now) })
        .where(eq(t.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

/**
 * The in-memory counterpart: the due rows, oldest first, each with its attempt
 * counted and its lease taken. Synchronous below the first `await`, so two
 * callers in one process cannot interleave into the claim.
 */
export function claimDueMemoryRows<
  T extends { attempts: number; nextAttemptAt: Date },
>(
  rows: Map<string, T & { id: string }>,
  isDue: (row: T) => boolean,
  limit: number,
  now: Date,
  clone: (row: T & { id: string }) => T & { id: string },
): (T & { id: string })[] {
  const due = [...rows.values()]
    .filter((row) => isDue(row) && row.nextAttemptAt <= now)
    .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
    .slice(0, limit);
  const claimed: (T & { id: string })[] = [];
  for (const row of due) {
    const next = clone(row);
    next.attempts = row.attempts + 1;
    next.nextAttemptAt = leaseUntil(now);
    rows.set(row.id, clone(next));
    claimed.push(next);
  }
  return claimed;
}
