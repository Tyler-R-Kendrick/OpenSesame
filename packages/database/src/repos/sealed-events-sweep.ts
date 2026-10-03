/**
 * Seal the event rows an older release left in the clear (ADR 0157).
 *
 * Run at start-up, idempotent: a row already sealed is not selected, and an
 * interrupted pass simply finds the rest next time. Each batch is read, sealed
 * and written back by primary key, so no row is ever written twice with
 * different plaintext.
 */

import type { JsonObject } from "@opensesame/os-domain";
import { eq, sql } from "drizzle-orm";
import { type EventSealer, SEALED_FIELD } from "../event-seal.js";
import * as schema from "../schema/index.js";
import type { Database } from "./postgres.js";

const BATCH = 200;

interface Row {
  id: string;
  value: JsonObject;
}

async function sweep(
  purpose: string,
  sealer: EventSealer,
  read: () => Promise<Row[]>,
  write: (id: string, value: JsonObject) => Promise<void>,
): Promise<number> {
  let sealed = 0;
  for (;;) {
    const rows = await read();
    if (rows.length === 0) return sealed;
    for (const row of rows) {
      await write(row.id, sealer.seal(purpose, row.value));
    }
    sealed += rows.length;
  }
}

/** How many rows were sealed, per table. */
export interface SweepCounts {
  audit: number;
  outbox: number;
  webhook: number;
  notification: number;
}

export async function sealLegacyEvents(
  db: Database,
  sealer: EventSealer,
): Promise<SweepCounts> {
  const audit = await sweep(
    "audit_events.metadata",
    sealer,
    () =>
      db
        .select({
          id: schema.auditEvents.id,
          value: schema.auditEvents.metadata,
        })
        .from(schema.auditEvents)
        .where(
          sql`not jsonb_exists(${schema.auditEvents.metadata}, ${SEALED_FIELD})`,
        )
        .limit(BATCH),
    async (id, value) => {
      await db
        .update(schema.auditEvents)
        .set({ metadata: value })
        .where(eq(schema.auditEvents.id, id));
    },
  );
  const outbox = await sweep(
    "outbox_events.payload",
    sealer,
    () =>
      db
        .select({
          id: schema.outboxEvents.id,
          value: schema.outboxEvents.payload,
        })
        .from(schema.outboxEvents)
        .where(
          sql`not jsonb_exists(${schema.outboxEvents.payload}, ${SEALED_FIELD})`,
        )
        .limit(BATCH),
    async (id, value) => {
      await db
        .update(schema.outboxEvents)
        .set({ payload: value })
        .where(eq(schema.outboxEvents.id, id));
    },
  );
  const webhook = await sweep(
    "webhook_deliveries.payload",
    sealer,
    () =>
      db
        .select({
          id: schema.webhookDeliveries.id,
          value: schema.webhookDeliveries.payload,
        })
        .from(schema.webhookDeliveries)
        .where(
          sql`not jsonb_exists(${schema.webhookDeliveries.payload}, ${SEALED_FIELD})`,
        )
        .limit(BATCH),
    async (id, value) => {
      await db
        .update(schema.webhookDeliveries)
        .set({ payload: value })
        .where(eq(schema.webhookDeliveries.id, id));
    },
  );
  const notification = await sweep(
    "notification_deliveries.payload",
    sealer,
    () =>
      db
        .select({
          id: schema.notificationDeliveries.id,
          value: schema.notificationDeliveries.payload,
        })
        .from(schema.notificationDeliveries)
        .where(
          sql`not jsonb_exists(${schema.notificationDeliveries.payload}, ${SEALED_FIELD})`,
        )
        .limit(BATCH),
    async (id, value) => {
      await db
        .update(schema.notificationDeliveries)
        .set({ payload: value })
        .where(eq(schema.notificationDeliveries.id, id));
    },
  );
  return { audit, outbox, webhook, notification };
}
