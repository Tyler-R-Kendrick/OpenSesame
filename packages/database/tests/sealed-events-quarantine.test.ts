import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventSealer, withSealedEvents } from "../src/index.js";
import { UNREADABLE_REASON } from "../src/repos/sealed-events.js";
import * as schema from "../src/schema/index.js";
import { makeNotificationDelivery, makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

/**
 * A queued row whose sealed value will not open is quarantined by itself, and
 * a delivery read back is opened (ADR 0157). Assertions read the table.
 */
const sealer = createEventSealer("test-event-secret-with-at-least-32-chars");
const oldSealer = createEventSealer(
  "a-previous-event-secret-of-32-chars-or-more",
);
const PLAINTEXT = "hunter2-do-not-store";

let ctx: PgTestContext;
beforeAll(async () => {
  ctx = await createPgTestContext();
});
afterAll(async () => {
  await ctx.client.close();
});

const outboxEvent = (aggregateId: string) => ({
  id: randomUUID(),
  aggregateType: "t",
  aggregateId,
  eventType: "e.test",
  payload: { secret: PLAINTEXT },
});

describe("an unreadable queued row", () => {
  it("is quarantined and does not hold the outbox behind it", async () => {
    const stale = await withSealedEvents(ctx.repos, oldSealer).outbox.append(
      outboxEvent("stale"),
    );
    const repos = withSealedEvents(ctx.repos, sealer);
    const fresh = await repos.outbox.append(outboxEvent("fresh"));

    const claimed = await repos.outbox.claimUnpublished(10);
    expect(claimed.map((e) => e.id)).toEqual([fresh.id]);

    const [row] = await ctx.db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, stale.id));
    expect(row?.publishedAt).toBeInstanceOf(Date);
    expect(row?.lastError).toBe(UNREADABLE_REASON);
    expect(JSON.stringify(row?.payload)).toContain("$sealed");
    expect(
      (
        await repos.outbox.claimUnpublished(
          10,
          new Date(Date.now() + 3_600_000),
        )
      ).map((e) => e.id),
    ).not.toContain(stale.id);
  });

  it("is dead-lettered by a delivery claim, and the rest are delivered", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const stale = await withSealedEvents(
      ctx.repos,
      oldSealer,
    ).notificationDeliveries.enqueue(
      makeNotificationDelivery(principal.id, { payload: { body: PLAINTEXT } }),
    );
    const repos = withSealedEvents(ctx.repos, sealer);
    const fresh = await repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principal.id, { payload: { body: PLAINTEXT } }),
    );

    const due = await repos.notificationDeliveries.claimDue(
      10,
      new Date(Date.now() + 1000),
    );
    expect(due.map((d) => d.id)).toEqual([fresh.id]);

    const [row] = await ctx.db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.id, stale.id));
    expect(row?.state).toBe("dead");
    expect(row?.lastError).toBe(UNREADABLE_REASON);
  });
});

describe("a notification delivery listed for a request", () => {
  it("comes back opened, not as its sealed envelope", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const authReqId = `ar_${randomUUID()}`;
    const repos = withSealedEvents(ctx.repos, sealer);
    await repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principal.id, {
        authReqId,
        payload: { body: PLAINTEXT },
      }),
    );
    const listed = await repos.notificationDeliveries.listForRequest(authReqId);
    expect(listed.map((d) => d.payload)).toEqual([{ body: PLAINTEXT }]);
    const [raw] =
      await ctx.repos.notificationDeliveries.listForRequest(authReqId);
    expect(JSON.stringify(raw?.payload)).toContain("$sealed");
  });
});
