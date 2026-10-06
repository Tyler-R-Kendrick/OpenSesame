/**
 * Seal the event rows an older release left in the clear (ADR 0157).
 *
 * Run at start-up in bounded keyset batches. Existing envelopes authenticate; an
 * interrupted pass simply finds the rest next time. Legacy plaintext and v1 are
 * resealed under their customer and record context. Conditional updates preserve
 * concurrent rotations. Recognized v2 values are verified and left unchanged.
 */

import { type JsonObject, isString } from "@opensesame/os-domain";
import { and, eq, gt, sql } from "drizzle-orm";
import { type EventSealer, SEALED_FIELD } from "../event-seal.js";
import * as schema from "../schema/index.js";
import type { Database } from "./postgres.js";

const BATCH = 200;

interface Row {
  id: string;
  value: JsonObject;
  scope: string | null;
  aggregateType?: string;
  aggregateId?: string;
}

async function sweep(
  purpose: string,
  sealer: EventSealer,
  read: (cursor: string) => Promise<Row[]>,
  write: (id: string, value: JsonObject, previous: JsonObject) => Promise<void>,
): Promise<number> {
  let sealed = 0;
  let cursor = "";
  for (;;) {
    const rows = await read(cursor);
    if (rows.length === 0) return sealed;
    for (const row of rows) {
      cursor = row.id;
      const scope =
        row.aggregateType !== undefined
          ? JSON.stringify([row.aggregateType, row.aggregateId])
          : (row.scope ?? "deployment");
      const context = `${purpose}:${row.id}`;
      const plain = sealer.openLegacyForMigration(context, row.value, scope);
      // Authentication above also refuses malformed/unknown markers at startup.
      if (
        isString(row.value[SEALED_FIELD]) &&
        row.value[SEALED_FIELD].startsWith("osev2.")
      )
        continue;
      await write(row.id, sealer.seal(context, plain, scope), row.value);
      sealed += 1;
    }
  }
}

/** How many rows were sealed, per table. */
export interface SweepCounts {
  audit: number;
  outbox: number;
  webhook: number;
  notification: number;
}

async function sweepAudit(db: Database, sealer: EventSealer): Promise<number> {
  return sweep(
    "audit_events.metadata",
    sealer,
    (cursor) =>
      db
        .select({
          id: schema.auditEvents.id,
          value: schema.auditEvents.metadata,
          scope: sql<
            string | null
          >`coalesce(${schema.auditEvents.organizationId}, ${schema.auditEvents.principalId})`,
        })
        .from(schema.auditEvents)
        .where(gt(schema.auditEvents.id, cursor))
        .orderBy(schema.auditEvents.id)
        .limit(BATCH),
    async (id, value, previous) => {
      await db
        .update(schema.auditEvents)
        .set({ metadata: value })
        .where(
          and(
            eq(schema.auditEvents.id, id),
            sql`${schema.auditEvents.metadata} = ${JSON.stringify(previous)}::jsonb`,
          ),
        );
    },
  );
}

async function sweepOutbox(db: Database, sealer: EventSealer): Promise<number> {
  return sweep(
    "outbox_events.payload",
    sealer,
    (cursor) =>
      db
        .select({
          id: schema.outboxEvents.id,
          value: schema.outboxEvents.payload,
          scope: sql<string>`'deployment'`,
          aggregateType: schema.outboxEvents.aggregateType,
          aggregateId: schema.outboxEvents.aggregateId,
        })
        .from(schema.outboxEvents)
        .where(gt(schema.outboxEvents.id, cursor))
        .orderBy(schema.outboxEvents.id)
        .limit(BATCH),
    async (id, value, previous) => {
      await db
        .update(schema.outboxEvents)
        .set({ payload: value })
        .where(
          and(
            eq(schema.outboxEvents.id, id),
            sql`${schema.outboxEvents.payload} = ${JSON.stringify(previous)}::jsonb`,
          ),
        );
    },
  );
}

async function sweepWebhook(
  db: Database,
  sealer: EventSealer,
): Promise<number> {
  return sweep(
    "webhook_deliveries.payload",
    sealer,
    (cursor) =>
      db
        .select({
          id: schema.webhookDeliveries.id,
          value: schema.webhookDeliveries.payload,
          scope: schema.webhookDeliveries.endpointId,
        })
        .from(schema.webhookDeliveries)
        .where(gt(schema.webhookDeliveries.id, cursor))
        .orderBy(schema.webhookDeliveries.id)
        .limit(BATCH),
    async (id, value, previous) => {
      await db
        .update(schema.webhookDeliveries)
        .set({ payload: value })
        .where(
          and(
            eq(schema.webhookDeliveries.id, id),
            sql`${schema.webhookDeliveries.payload} = ${JSON.stringify(previous)}::jsonb`,
          ),
        );
    },
  );
}

async function sweepNotification(
  db: Database,
  sealer: EventSealer,
): Promise<number> {
  return sweep(
    "notification_deliveries.payload",
    sealer,
    (cursor) =>
      db
        .select({
          id: schema.notificationDeliveries.id,
          value: schema.notificationDeliveries.payload,
          scope: schema.notificationDeliveries.principalId,
        })
        .from(schema.notificationDeliveries)
        .where(gt(schema.notificationDeliveries.id, cursor))
        .orderBy(schema.notificationDeliveries.id)
        .limit(BATCH),
    async (id, value, previous) => {
      await db
        .update(schema.notificationDeliveries)
        .set({ payload: value })
        .where(
          and(
            eq(schema.notificationDeliveries.id, id),
            sql`${schema.notificationDeliveries.payload} = ${JSON.stringify(previous)}::jsonb`,
          ),
        );
    },
  );
}

export async function sealLegacyEvents(
  db: Database,
  sealer: EventSealer,
  allowLegacy = true,
): Promise<SweepCounts> {
  const eventSealer = allowLegacy
    ? sealer
    : { ...sealer, openLegacyForMigration: sealer.openCurrent.bind(sealer) };
  const audit = await sweepAudit(db, eventSealer);
  const outbox = await sweepOutbox(db, eventSealer);
  const webhook = await sweepWebhook(db, eventSealer);
  const notification = await sweepNotification(db, eventSealer);
  return { audit, outbox, webhook, notification };
}
