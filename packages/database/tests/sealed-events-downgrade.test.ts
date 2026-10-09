import { createCipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { JsonObject } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  EventSealError,
  createEventSealer,
  sealLegacyEvents,
  withSealedEvents,
} from "../src/index.js";
import { UNREADABLE_REASON } from "../src/repos/sealed-events.js";
import * as schema from "../src/schema/index.js";
import {
  makeAuditEvent,
  makeNotificationDelivery,
  makePrincipal,
} from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

const secret = "event downgrade replay regression deployment root";
const sealer = createEventSealer(secret);
let ctx: PgTestContext;
beforeAll(async () => {
  ctx = await createPgTestContext();
});
afterAll(async () => {
  await ctx.client.close();
});

function legacy(purpose: string, plain: JsonObject): JsonObject {
  const key = Buffer.from(
    hkdfSync("sha256", secret, "", "opensesame:event-seal:v1", 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([
    iv,
    cipher.update(JSON.stringify(plain)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { $sealed: `osev1.${body.toString("base64url")}` };
}

it.each(["plaintext", "osev1"])(
  "refuses %s replay into a migrated audit row",
  async (format) => {
    const plain = { secret: "audit replay canary" };
    const replay =
      format === "plaintext" ? plain : legacy("audit_events.metadata", plain);
    const event = makeAuditEvent({ metadata: replay });
    await ctx.db.insert(schema.auditEvents).values(event);
    await sealLegacyEvents(ctx.db, sealer);
    const repos = withSealedEvents(ctx.repos, sealer);
    expect(
      (await repos.auditEvents.list({})).some((row) => row.id === event.id),
    ).toBe(true);
    await ctx.db
      .update(schema.auditEvents)
      .set({ metadata: replay })
      .where(eq(schema.auditEvents.id, event.id));
    await expect(repos.auditEvents.list({})).rejects.toThrow(EventSealError);
    await ctx.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.id, event.id));
  },
);

it.each(["plaintext", "osev1"])(
  "quarantines %s replay into a migrated outbox row",
  async (format) => {
    const plain = { secret: "outbox replay canary" };
    const replay =
      format === "plaintext" ? plain : legacy("outbox_events.payload", plain);
    const event = {
      id: randomUUID(),
      aggregateType: "customer",
      aggregateId: randomUUID(),
      eventType: "test",
      payload: replay,
    };
    await ctx.repos.outbox.append(event);
    await sealLegacyEvents(ctx.db, sealer);
    const repos = withSealedEvents(ctx.repos, sealer);
    expect(
      (await repos.outbox.listUnpublished(100)).some(
        (row) => row.id === event.id,
      ),
    ).toBe(true);
    await ctx.db
      .update(schema.outboxEvents)
      .set({ payload: replay })
      .where(eq(schema.outboxEvents.id, event.id));
    expect(
      (await repos.outbox.listUnpublished(100)).some(
        (row) => row.id === event.id,
      ),
    ).toBe(false);
    expect(
      (await repos.outbox.claimUnpublished(100)).some(
        (row) => row.id === event.id,
      ),
    ).toBe(false);
    const [stored] = await ctx.db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event.id));
    expect(stored?.lastError).toBe(UNREADABLE_REASON);
    expect(stored?.payload).toEqual(replay);
  },
);

it.each(["plaintext", "osev1"])(
  "rejects %s notification replay on listing and quarantines claims",
  async (format) => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const plain = { secret: "notification replay canary" };
    const replay =
      format === "plaintext"
        ? plain
        : legacy("notification_deliveries.payload", plain);
    const authReqId = randomUUID();
    const delivery = makeNotificationDelivery(principal.id, {
      payload: replay,
      authReqId,
    });
    await ctx.repos.notificationDeliveries.enqueue(delivery);
    await sealLegacyEvents(ctx.db, sealer);
    const repos = withSealedEvents(ctx.repos, sealer);
    expect(
      await repos.notificationDeliveries.listForRequest(authReqId),
    ).toHaveLength(1);
    await ctx.db
      .update(schema.notificationDeliveries)
      .set({ payload: replay })
      .where(eq(schema.notificationDeliveries.id, delivery.id));
    await expect(
      repos.notificationDeliveries.listForRequest(authReqId),
    ).rejects.toThrow(EventSealError);
    expect(
      (
        await repos.notificationDeliveries.claimDue(
          100,
          new Date(Date.now() + 1000),
        )
      ).some((row) => row.id === delivery.id),
    ).toBe(false);
    const [stored] = await ctx.db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.id, delivery.id));
    expect(stored?.state).toBe("dead");
    expect(stored?.lastError).toBe(UNREADABLE_REASON);
    expect(stored?.payload).toEqual(replay);
  },
);

it.each(["plaintext", "osev1"])(
  "dead-letters %s webhook replay after migration",
  async (format) => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const now = new Date();
    const endpoint = await ctx.repos.webhookEndpoints.create({
      id: randomUUID(),
      principalId: principal.id,
      url: "https://hooks.example.test/in",
      secret: "webhook-test-key",
      createdAt: now,
    });
    const plain = { secret: "webhook replay canary" };
    const replay =
      format === "plaintext"
        ? plain
        : legacy("webhook_deliveries.payload", plain);
    const delivery = {
      id: randomUUID(),
      endpointId: endpoint.id,
      eventType: "test",
      payload: replay,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    };
    await ctx.repos.webhookDeliveries.enqueue(delivery);
    await sealLegacyEvents(ctx.db, sealer);
    const [migrated] = await ctx.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    expect(migrated?.payload.$sealed).toMatch(/^osev2\./);
    await ctx.db
      .update(schema.webhookDeliveries)
      .set({ payload: replay })
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    const repos = withSealedEvents(ctx.repos, sealer);
    expect(
      (
        await repos.webhookDeliveries.claimDue(100, new Date(Date.now() + 1000))
      ).some((row) => row.id === delivery.id),
    ).toBe(false);
    const [stored] = await ctx.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    expect(stored?.deadAt).toBeInstanceOf(Date);
    expect(stored?.lastError).toBe(UNREADABLE_REASON);
    expect(stored?.payload).toEqual(replay);
  },
);
