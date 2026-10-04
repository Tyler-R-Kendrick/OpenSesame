import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DELIVERY_LEASE_MS,
  MemoryRepositories,
  type Repositories,
} from "../src/index.js";
import { makeNotificationDelivery, makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

/**
 * A claim is a lease. `claimDue` used to count the attempt and nothing else, so
 * the row stayed due: a second replica, or the next tick after a slow one, took
 * the same row and sent it again while the first was still working on it.
 * The same contract runs on the in-memory repositories and on Postgres (PGlite,
 * or the real server named by DATABASE_URL).
 */

let pg: PgTestContext;
beforeAll(async () => {
  pg = await createPgTestContext();
}, 60_000);
afterAll(async () => {
  await pg.client.close();
});

interface Engine {
  name: string;
  repos: () => Repositories;
}

const engines: Engine[] = [
  { name: "MemoryRepositories", repos: () => new MemoryRepositories() },
  { name: "PostgresRepositories", repos: () => pg.repos },
];

describe.each(engines)("$name delivery leases", (engine) => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  const afterLease = new Date(now.getTime() + DELIVERY_LEASE_MS + 1);

  async function dueDelivery() {
    const repos = engine.repos();
    const principal = await repos.principals.create(makePrincipal());
    const authReqId = `areq_${randomUUID()}`;
    const row = await repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principal.id, { authReqId, nextAttemptAt: now }),
    );
    return { repos, authReqId, id: row.id };
  }

  it("does not hand a claimed row to a second claimer while the lease holds", async () => {
    const { repos, id } = await dueDelivery();
    const first = await repos.notificationDeliveries.claimDue(1000, now);
    expect(first.map((row) => row.id)).toContain(id);

    const later = new Date(now.getTime() + DELIVERY_LEASE_MS - 1_000);
    const second = await repos.notificationDeliveries.claimDue(1000, later);
    expect(second.map((row) => row.id)).not.toContain(id);
  });

  it("makes the row due again once the lease has run out, having burned one attempt per claim", async () => {
    const { repos, authReqId } = await dueDelivery();
    await repos.notificationDeliveries.claimDue(1000, now);
    const [reclaimed] = (
      await repos.notificationDeliveries.claimDue(1000, afterLease)
    ).filter((row) => row.authReqId === authReqId);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("lets a recorded failure schedule the retry itself, lease or not", async () => {
    const { repos, authReqId, id } = await dueDelivery();
    await repos.notificationDeliveries.claimDue(1000, now);
    const retryAt = new Date(now.getTime() + 30_000);
    await repos.notificationDeliveries.recordFailure(
      id,
      "status:503",
      retryAt,
      false,
    );
    const [row] = await repos.notificationDeliveries.listForRequest(authReqId);
    expect(row?.nextAttemptAt).toEqual(retryAt);
    const due = await repos.notificationDeliveries.claimDue(1000, retryAt);
    expect(due.map((r) => r.id)).toContain(id);
  });

  it("leases a webhook delivery the same way", async () => {
    const repos = engine.repos();
    const principal = await repos.principals.create(makePrincipal());
    const endpoint = await repos.webhookEndpoints.create({
      id: `whe_${randomUUID()}`,
      principalId: principal.id,
      url: "https://hooks.example.test/in",
      secret: "whsec_test",
      createdAt: now,
    });
    const delivery = await repos.webhookDeliveries.enqueue({
      id: `whd_${randomUUID()}`,
      endpointId: endpoint.id,
      eventType: "authority.invocation.requested",
      payload: {},
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    });
    const first = await repos.webhookDeliveries.claimDue(1000, now);
    expect(first.map((row) => row.id)).toContain(delivery.id);
    expect(
      (await repos.webhookDeliveries.claimDue(1000, now)).map((r) => r.id),
    ).not.toContain(delivery.id);
    expect(
      (await repos.webhookDeliveries.claimDue(1000, afterLease)).map(
        (r) => r.id,
      ),
    ).toContain(delivery.id);
  });
});
