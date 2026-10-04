import { MemoryRepositories } from "@opensesame/database";
import {
  WebPushConfigError,
  generateVapidKeyPair,
} from "@opensesame/notification-adapters";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanupTick } from "../cleanup.js";
import { MemoryTaskBus } from "../taskBus.js";
import { createWorkerNotificationAdapters } from "../web-push-channel.js";
import {
  APPROVER,
  AUTH_REQ,
  NOW,
  SUBJECT,
  type World,
  type WorldOptions,
  env,
  makeWorld,
  vapid,
} from "./web-push-world.js";

/**
 * Web Push through the real worker, the real adapter and a stand-in push
 * service that checks VAPID with `jws` and decrypts with `http_ece`.
 *
 * Nothing between the outbox row and the HTTP request is faked: the tick
 * routes the event with `planNotificationRoute`, renders through the Web Push
 * adapter's closed vocabulary, claims the delivery row, lists the person's
 * subscriptions and posts an encrypted, signed request. Only the push service
 * is a stand-in, and it can say no.
 */

let current: World | undefined;
afterEach(async () => {
  await current?.service.close();
  current = undefined;
});

async function open(options: WorldOptions = {}) {
  current = await makeWorld(new MemoryRepositories(), options);
  return current;
}

describe("web push through the worker", () => {
  it("delivers an authorization request as the service worker's closed vocabulary", async () => {
    const w = await open();
    const sub = w.service.mint();
    await w.enrol(sub);
    await w.ask();
    const arrival = w.service.next(5000);

    const result = await w.tick();
    expect(result.outboxPublished).toBe(1);
    expect(result.notificationsEnqueued).toBe(1);
    expect(result.notificationsDelivered).toBe(1);
    expect(result.notificationsDead).toBe(0);

    const push = await arrival;
    expect(push.json).toEqual({
      kind: "authorization_request",
      action: "review",
      ref: AUTH_REQ,
    });
    expect(push.subscriptionId).toBe(sub.id);
    expect(push.vapid.claims.aud).toBe(w.service.publicOrigin);
    expect(push.vapid.claims.sub).toBe(SUBJECT);
    // The request's own words are not on the wire, even encrypted.
    expect(push.payload).not.toContain("4417");
    expect(push.payload).not.toContain("sha256:abc");
    expect(push.payload).not.toContain(APPROVER);
    const [row] = await w.rows();
    expect(row).toMatchObject({ kind: "native_push", state: "delivered" });
  });

  it("rings every enrolled browser once", async () => {
    const w = await open();
    const phone = w.service.mint();
    const laptop = w.service.mint();
    await w.enrol(phone);
    await w.enrol(laptop);
    await w.ask();
    expect((await w.tick()).notificationsDelivered).toBe(1);
    expect(
      w.service.received
        .filter((r) => r.ok)
        .map((r) => r.subscriptionId)
        .sort(),
    ).toEqual([laptop.id, phone.id].sort());
  });

  it("retires a subscription the push service says is gone, and the row dies honestly", async () => {
    const w = await open();
    const sub = w.service.mint();
    const subscriptionId = await w.enrol(sub);
    w.service.respondWith(sub.id, 410);
    await w.ask();

    const result = await w.tick();
    expect(result.notificationsDelivered).toBe(0);
    expect(result.notificationsDead).toBe(1);
    const [row] = await w.rows();
    expect(row).toMatchObject({
      kind: "native_push",
      state: "dead",
      lastError: "status:410",
    });
    expect(await w.repos.pushSubscriptions.listForPrincipal(APPROVER)).toEqual(
      [],
    );
    const retired = await w.repos.pushSubscriptions.getById(subscriptionId);
    expect(retired?.disabledAt).toEqual(NOW);
  });

  it("delivers to the live browser and retires only the dead one", async () => {
    const w = await open();
    const gone = w.service.mint();
    const live = w.service.mint();
    const goneId = await w.enrol(gone);
    const liveId = await w.enrol(live);
    w.service.unregister(gone.id); // the push service now answers 404 for it
    await w.ask();

    expect((await w.tick()).notificationsDelivered).toBe(1);
    expect((await w.rows())[0]?.state).toBe("delivered");
    expect(
      (await w.repos.pushSubscriptions.getById(goneId))?.disabledAt,
    ).toBeDefined();
    expect(
      (await w.repos.pushSubscriptions.getById(liveId))?.disabledAt,
    ).toBeUndefined();
    expect(
      w.service.received.filter((r) => r.ok).map((r) => r.subscriptionId),
    ).toEqual([live.id]);
  });

  it("retries a push service that is busy, keeps the subscription, and delivers later", async () => {
    const w = await open();
    const sub = w.service.mint();
    const subscriptionId = await w.enrol(sub);
    w.service.respondWith(sub.id, 503);
    await w.ask();

    const first = await w.tick();
    expect(first.notificationsDelivered).toBe(0);
    expect(first.notificationsDead).toBe(0);
    const [waiting] = await w.rows();
    expect(waiting).toMatchObject({ state: "failed", lastError: "status:503" });
    expect(waiting?.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(
      (await w.repos.pushSubscriptions.getById(subscriptionId))?.disabledAt,
    ).toBeUndefined();

    w.service.respondWith(sub.id, undefined);
    w.clock.now = new Date(NOW.getTime() + 60 * 60 * 1000);
    const arrival = w.service.next(5000);
    expect((await w.tick()).notificationsDelivered).toBe(1);
    expect((await arrival).json).toMatchObject({ ref: AUTH_REQ });
  });

  it("does not retire a subscription because the operator's VAPID identity was refused", async () => {
    // The push service was told a different application server key.
    const w = await open({ standInKey: generateVapidKeyPair().publicKey });
    const sub = w.service.mint();
    const subscriptionId = await w.enrol(sub);
    await w.ask();

    const result = await w.tick();
    expect(result.notificationsDead).toBe(1);
    expect((await w.rows())[0]?.lastError).toBe("status:401");
    expect(
      (await w.repos.pushSubscriptions.getById(subscriptionId))?.disabledAt,
    ).toBeUndefined();
  });

  it("dead-letters a person with no subscription instead of retrying forever", async () => {
    const w = await open();
    await w.ask();
    const result = await w.tick();
    expect(result.notificationsEnqueued).toBe(1);
    expect(result.notificationsDead).toBe(1);
    expect((await w.rows())[0]).toMatchObject({
      state: "dead",
      lastError: "no_subscription",
    });
    expect(w.service.received).toHaveLength(0);
  });

  it("renders a decision notice with its own action label", async () => {
    const w = await open();
    const sub = w.service.mint();
    await w.enrol(sub);
    await w.repos.notificationPreferences.upsert({
      principalId: APPROVER,
      byClass: {
        authorization_decision: {
          channels: ["native_push", "in_app"],
          fanOut: false,
        },
      },
      updatedAt: NOW,
      version: 2,
    });
    await w.repos.outbox.append({
      id: "obx_decision",
      aggregateType: "authorization_request",
      aggregateId: AUTH_REQ,
      eventType: "authority.invocation.completed",
      availableAt: NOW,
      payload: { principalId: APPROVER, authReqId: AUTH_REQ },
    });
    const arrival = w.service.next(5000);
    expect((await w.tick()).notificationsDelivered).toBe(1);
    expect((await arrival).json).toEqual({
      kind: "authorization_decision",
      action: "decided",
      ref: AUTH_REQ,
    });
  });
});

describe("the worker's Web Push configuration", () => {
  const repos = new MemoryRepositories();

  it("has no adapter, and says so, without a private key", () => {
    for (const environment of [
      {},
      { OPENSESAME_WEBPUSH_PUBLIC_KEY: vapid.publicKey },
    ]) {
      const registry = createWorkerNotificationAdapters({
        repos,
        env: environment,
      });
      expect(registry.availableChannels()).toEqual([]);
      expect(registry.get("native_push")).toBeUndefined();
    }
  });

  it("offers native_push with a usable identity", () => {
    const registry = createWorkerNotificationAdapters({ repos, env: env() });
    expect(registry.availableChannels()).toEqual(["native_push"]);
  });

  it("refuses to start with a private key that is not the public key's", () => {
    expect(() =>
      createWorkerNotificationAdapters({
        repos,
        env: env({
          OPENSESAME_WEBPUSH_PRIVATE_KEY: generateVapidKeyPair().privateKey,
        }),
      }),
    ).toThrow(WebPushConfigError);
  });

  it("collapses a plan to the inbox when Web Push is not configured", async () => {
    const empty = new MemoryRepositories();
    await empty.notificationPreferences.upsert({
      principalId: APPROVER,
      byClass: {
        authorization_request: {
          channels: ["native_push", "in_app"],
          fanOut: false,
        },
      },
      updatedAt: NOW,
      version: 1,
    });
    await empty.outbox.append({
      id: "obx_none",
      aggregateType: "authorization_request",
      aggregateId: AUTH_REQ,
      eventType: "authority.invocation.requested",
      availableAt: NOW,
      payload: { principalId: APPROVER, authReqId: AUTH_REQ },
    });
    const result = await runCleanupTick({
      repos: empty,
      clock: () => NOW,
      taskBus: new MemoryTaskBus(),
      notificationAdapters: createWorkerNotificationAdapters({
        repos: empty,
        env: {},
      }),
    });
    expect(result.notificationsEnqueued).toBe(0);
    expect(result.notificationsDelivered).toBe(0);
  });
});
