import { randomUUID } from "node:crypto";
import {
  type Repositories,
  createDrizzle,
  createRepositories,
  runMigrations,
} from "@opensesame/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPROVER,
  AUTH_REQ,
  NOW,
  type World,
  makeWorld,
} from "./web-push-world.js";

/**
 * The worker's Web Push tick against a real Postgres, through the production
 * driver. The in-memory suite proves the worker; this proves the rows: the
 * claim queries that bound a `Date` raw-SQL fragment (which postgres-js cannot
 * serialize, so `runCleanupTick` threw on every tick) and the unique indexes
 * the dispatcher leans on.
 *
 * Runs when `DATABASE_URL` names a server whose role can create databases
 * (`pnpm --filter @opensesame/identity-worker test:postgres`, which refuses to
 * run without it, and CI); a plain `test` shows it as skipped. Each run builds
 * and drops a database of its own.
 */

const url = process.env.DATABASE_URL?.trim();

function withDatabase(base: string, name: string): string {
  const next = new URL(base);
  next.pathname = `/${name}`;
  return next.toString();
}

describe.skipIf(!url)("web push through the worker on Postgres", () => {
  const name = `t_${randomUUID().replaceAll("-", "")}`;
  let repos: Repositories;
  let world: World | undefined;
  const current = (): World => {
    if (!world) throw new Error("the Postgres world was not built");
    return world;
  };
  let admin: ReturnType<typeof createDrizzle>["sql"];

  beforeAll(async () => {
    const base = url ?? "";
    admin = createDrizzle(base).sql;
    await admin.unsafe(`create database "${name}"`);
    await runMigrations(withDatabase(base, name));
    repos = createRepositories({
      databaseUrl: withDatabase(base, name),
      eventSealSecret: "web-push-postgres-test-secret-32-characters",
    });
    world = await makeWorld(repos);
  }, 60_000);

  afterAll(async () => {
    await world?.service.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end({ timeout: 5 });
  });

  it("publishes the outbox, delivers the push and settles the row", async () => {
    const w = current();
    const sub = w.service.mint();
    await w.enrol(sub);
    await w.ask();
    const arrival = w.service.next(5000);

    const result = await w.tick();
    expect(result.outboxPublished).toBe(1);
    expect(result.notificationsDelivered).toBe(1);
    expect((await arrival).json).toEqual({
      kind: "authorization_request",
      action: "review",
      ref: AUTH_REQ,
    });
    const rows = await w.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "native_push", state: "delivered" });
  });

  it("retires a gone subscription and dead-letters the row", async () => {
    const w = current();
    // The first test's browser is still enrolled and would take the push.
    for (const earlier of await w.repos.pushSubscriptions.listForPrincipal(
      APPROVER,
    )) {
      await w.repos.pushSubscriptions.disable(earlier.id, NOW);
    }
    const gone = w.service.mint();
    const id = await w.enrol(gone);
    w.service.respondWith(gone.id, 410);
    await w.ask("obx_gone");

    const result = await w.tick();
    expect(result.notificationsDead).toBeGreaterThanOrEqual(1);
    const retired = await w.repos.pushSubscriptions.getById(id);
    expect(retired?.disabledAt).toEqual(NOW);
    const dead = (await w.rows()).filter((row) => row.state === "dead");
    expect(dead.at(-1)?.lastError).toBe("status:410");
  });
});
