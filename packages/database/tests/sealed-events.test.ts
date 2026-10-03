import { randomUUID } from "node:crypto";
import type { JsonObject } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EventSealError,
  PostgresRepositories,
  SEALED_FIELD,
  createEventSealer,
  eventSealSecret,
  sealLegacyEvents,
  withSealedEvents,
} from "../src/index.js";
import * as schema from "../src/schema/index.js";
import {
  makeAuditEvent,
  makeNotificationDelivery,
  makePrincipal,
} from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

/**
 * Event rows at rest (ADR 0157). Every assertion reads the table itself, not
 * the repository: what a database dump, a replica or a read-only SQL account
 * would see.
 */
const SECRET = "test-event-secret-with-at-least-32-chars";
const PLAINTEXT = "hunter2-do-not-store";

let ctx: PgTestContext;
const sealer = createEventSealer(SECRET);

beforeAll(async () => {
  ctx = await createPgTestContext();
});
afterAll(async () => {
  await ctx.client.close();
});

function rawText(value: JsonObject | null | undefined): string {
  return JSON.stringify(value ?? {});
}

describe("the sealer", () => {
  it("round-trips and never contains the plaintext", () => {
    const sealed = sealer.seal("t.c", { note: PLAINTEXT });
    expect(Object.keys(sealed)).toEqual([SEALED_FIELD]);
    expect(rawText(sealed)).not.toContain(PLAINTEXT);
    expect(sealer.open("t.c", sealed)).toEqual({ note: PLAINTEXT });
  });

  it("opens only under its key and its column", () => {
    const sealed = sealer.seal("t.c", { n: 1 });
    expect(() => sealer.open("t.other", sealed)).toThrow(EventSealError);
    const other = createEventSealer("another-secret-with-at-least-32-chars!!");
    expect(() => other.open("t.c", sealed)).toThrow(EventSealError);
  });

  it("refuses a tampered payload instead of reading it as empty", () => {
    const sealed = sealer.seal("t.c", { n: 1 });
    const token = String(sealed[SEALED_FIELD]);
    const bad = { [SEALED_FIELD]: `${token.slice(0, -4)}AAAA` };
    expect(() => sealer.open("t.c", bad)).toThrow(EventSealError);
  });

  it("returns a legacy plaintext payload as it is", () => {
    expect(sealer.open("t.c", { a: 1 })).toEqual({ a: 1 });
  });

  it("refuses an empty secret, and never defaults one", () => {
    expect(() => createEventSealer("")).toThrow();
    expect(eventSealSecret({})).toBeUndefined();
    expect(eventSealSecret({ OPENSESAME_CLAIM_PEPPER: "p".repeat(40) })).toBe(
      "p".repeat(40),
    );
    expect(
      eventSealSecret({
        OPENSESAME_EVENT_KEY: "k".repeat(40),
        OPENSESAME_CLAIM_PEPPER: "p".repeat(40),
      }),
    ).toBe("k".repeat(40));
  });
});

describe("the decorator keeps the repositories whole", () => {
  it("survives an object spread and keeps its class", () => {
    const repos = withSealedEvents(ctx.repos, sealer);
    const spread = { ...repos };
    for (const name of [
      "principals",
      "claimSessions",
      "interactions",
      "auditEvents",
      "outbox",
    ] as const) {
      expect(spread[name], name).toBeDefined();
    }
    expect(repos).toBeInstanceOf(PostgresRepositories);
    expect(spread.claimSessions).toBe(ctx.repos.claimSessions);
  });
});

describe("Postgres event rows are sealed", () => {
  it("audit metadata rests sealed and reads back whole", async () => {
    const repos = withSealedEvents(ctx.repos, sealer);
    const event = makeAuditEvent({ metadata: { reason: PLAINTEXT } });
    const stored = await repos.auditEvents.append(event);
    expect(stored.metadata).toEqual({ reason: PLAINTEXT });

    const [row] = await ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.id, event.id));
    expect(rawText(row?.metadata)).not.toContain(PLAINTEXT);
    expect(Object.keys(row?.metadata ?? {})).toEqual([SEALED_FIELD]);

    const listed = await repos.auditEvents.list({ limit: 50 });
    expect(listed.find((e) => e.id === event.id)?.metadata).toEqual({
      reason: PLAINTEXT,
    });
  });

  it("the outbox is sealed once on either path", async () => {
    const repos = withSealedEvents(ctx.repos, sealer);
    const direct = await repos.outbox.append({
      id: randomUUID(),
      aggregateType: "t",
      aggregateId: "a",
      eventType: "e.direct",
      payload: { secret: PLAINTEXT },
    });
    const inTx = await repos.transaction((uow) =>
      uow.appendOutbox({
        id: randomUUID(),
        aggregateType: "t",
        aggregateId: "b",
        eventType: "e.tx",
        payload: { secret: PLAINTEXT },
      }),
    );
    const viaRepoInTx = await repos.transaction((uow) =>
      repos.outbox.append(
        {
          id: randomUUID(),
          aggregateType: "t",
          aggregateId: "c",
          eventType: "e.repo",
          payload: { secret: PLAINTEXT },
        },
        uow,
      ),
    );
    for (const event of [direct, inTx, viaRepoInTx]) {
      expect(event.payload).toEqual({ secret: PLAINTEXT });
      const [row] = await ctx.db
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.id, event.id));
      expect(rawText(row?.payload)).not.toContain(PLAINTEXT);
      // Sealed exactly once: one layer opens to the original, not to a seal.
      expect(sealer.open("outbox_events.payload", row?.payload ?? {})).toEqual({
        secret: PLAINTEXT,
      });
    }
    const claimed = await repos.outbox.claimUnpublished(50);
    expect(claimed.map((e) => e.payload)).toContainEqual({ secret: PLAINTEXT });
  });

  it("delivery payloads are sealed and their failure text is scrubbed", async () => {
    const repos = withSealedEvents(ctx.repos, sealer);
    const principal = await ctx.repos.principals.create(makePrincipal());
    const delivery = await repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principal.id, { payload: { body: PLAINTEXT } }),
    );
    const [row] = await ctx.db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.id, delivery.id));
    expect(rawText(row?.payload)).not.toContain(PLAINTEXT);

    const [due] = await repos.notificationDeliveries.claimDue(
      10,
      new Date(Date.now() + 1000),
    );
    expect(due?.payload).toEqual({ body: PLAINTEXT });

    await repos.notificationDeliveries.recordFailure(
      delivery.id,
      "POST https://hook.example/x?token=abc123 refused",
      new Date(Date.now() + 60_000),
      false,
    );
    const [failed] = await ctx.db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.id, delivery.id));
    expect(failed?.lastError).not.toContain("abc123");
    expect(failed?.lastError).toContain("refused");
  });

  it("a wrong key fails loudly rather than reading a row as empty", async () => {
    const wrong = withSealedEvents(
      ctx.repos,
      createEventSealer("another-secret-with-at-least-32-chars!!"),
    );
    await expect(wrong.auditEvents.list({ limit: 50 })).rejects.toBeInstanceOf(
      EventSealError,
    );
  });
});

describe("legacy rows are sealed in place", () => {
  it("the sweep seals every plaintext row, once, and leaves sealed rows alone", async () => {
    const legacy = makeAuditEvent({ metadata: { reason: PLAINTEXT } });
    await ctx.repos.auditEvents.append(legacy);
    await ctx.repos.outbox.append({
      id: randomUUID(),
      aggregateType: "t",
      aggregateId: "legacy",
      eventType: "e.legacy",
      payload: { secret: PLAINTEXT },
    });

    const first = await sealLegacyEvents(ctx.db, sealer);
    expect(first.audit).toBeGreaterThanOrEqual(1);
    expect(first.outbox).toBeGreaterThanOrEqual(1);

    const [row] = await ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.id, legacy.id));
    expect(rawText(row?.metadata)).not.toContain(PLAINTEXT);
    expect(sealer.open("audit_events.metadata", row?.metadata ?? {})).toEqual({
      reason: PLAINTEXT,
    });

    const second = await sealLegacyEvents(ctx.db, sealer);
    expect(second).toEqual({
      audit: 0,
      outbox: 0,
      webhook: 0,
      notification: 0,
    });
  });
});
