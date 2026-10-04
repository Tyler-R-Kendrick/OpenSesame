import { createHash } from "node:crypto";
import { MemoryRepositories } from "@opensesame/database";
import {
  createWebPushAdapter,
  generateVapidKeyPair,
} from "@opensesame/notification-adapters";
import { mintPushSubscription } from "@opensesame/notification-adapters/test-support";
import type { NotificationDelivery } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_DEADLINE_MS } from "../bounded.js";
import { createWebPushChannel } from "../web-push-channel.js";

/**
 * A person's black-holed subscriptions cost their own delivery one transport
 * timeout, not one each, and a send is never started with no time left to
 * finish it.
 */

const NOW = new Date("2026-10-04T12:00:00.000Z");
const PRINCIPAL = "prn_a";
const vapid = generateVapidKeyPair();

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(respond: (endpoint: string) => Promise<Response>) {
  const repos = new MemoryRepositories();
  const calls: string[] = [];
  const adapter = createWebPushAdapter({
    vapidPublicKey: vapid.publicKey,
    vapidPrivateKey: vapid.privateKey,
    vapidSubject: "mailto:ops@example.test",
    fetchImpl: async (input) => {
      calls.push(String(input));
      return respond(String(input));
    },
  });
  const channel = createWebPushChannel({
    adapter,
    subscriptions: repos.pushSubscriptions,
  });
  const endpoints: string[] = [];
  const enrol = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const sub = mintPushSubscription();
      endpoints.push(sub.endpoint);
      await repos.pushSubscriptions.create({
        id: `psub_${sub.id}`,
        principalId: PRINCIPAL,
        endpoint: sub.endpoint,
        p256dhKey: sub.keys.p256dh,
        authSecret: sub.keys.auth,
        endpointDigest: createHash("sha256").update(sub.endpoint).digest("hex"),
        createdAt: NOW,
      });
    }
  };
  const payload = await channel.render({
    eventType: "authority.invocation.requested",
    notificationClass: "authorization_request",
    confidentiality: "minimal",
    payload: { authReqId: "areq_1" },
  });
  const row: NotificationDelivery = {
    id: "ndl_1",
    principalId: PRINCIPAL,
    kind: "native_push",
    notificationClass: "authorization_request",
    eventType: "authority.invocation.requested",
    outboxEventId: "obx_1",
    payload,
    confidentiality: "minimal",
    state: "pending",
    attempts: 1,
    nextAttemptAt: NOW,
    createdAt: NOW,
  };
  const deliver = () => channel.deliver({ delivery: row, now: NOW });
  return { repos, calls, endpoints, enrol, deliver };
}

const transportTimeout = () =>
  new Promise<Response>((_resolve, reject) => {
    setTimeout(
      () => reject(new DOMException("timed out", "TimeoutError")),
      200,
    );
  });

describe("web push delivery to a person's subscriptions", () => {
  it("waits out black-holed subscriptions side by side, not one after another", async () => {
    const w = await setup(transportTimeout);
    await w.enrol(10);
    const started = Date.now();
    const outcome = await w.deliver();
    const elapsed = Date.now() - started;
    expect(outcome).toEqual({
      ok: false,
      retryable: true,
      error: "transport:TimeoutError",
    });
    expect(w.calls).toHaveLength(10);
    // Ten sequential 200 ms timeouts would take two seconds.
    expect(elapsed).toBeLessThan(1_200);
  });

  it("still delivers when one subscription answers among the black holes", async () => {
    let live = "";
    const w = await setup(async (endpoint) =>
      endpoint === live
        ? new Response(null, { status: 201 })
        : transportTimeout(),
    );
    await w.enrol(6);
    live = w.endpoints[3] ?? "";
    expect(await w.deliver()).toEqual({ ok: true });
    expect(w.calls).toHaveLength(6);
  });

  it("starts no send once there is no time left for it to finish", async () => {
    const w = await setup(async () => new Response(null, { status: 201 }));
    await w.enrol(4);
    // The first reading fixes the start-by time; every later one is past it.
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValueOnce(NOW.getTime());
    clock.mockReturnValue(NOW.getTime() + DELIVERY_DEADLINE_MS);
    const outcome = await w.deliver();
    expect(w.calls).toHaveLength(0);
    expect(outcome).toEqual({
      ok: false,
      retryable: true,
      error: "deadline_exceeded",
    });
  });

  it("retires a subscription whose endpoint is private, as the adapter reports it", async () => {
    const w = await setup(async () => new Response(null, { status: 201 }));
    await w.enrol(1);
    const sub = mintPushSubscription({ endpointOrigin: "https://10.1.2.3" });
    await w.repos.pushSubscriptions.create({
      id: "psub_private",
      principalId: PRINCIPAL,
      endpoint: sub.endpoint,
      p256dhKey: sub.keys.p256dh,
      authSecret: sub.keys.auth,
      endpointDigest: createHash("sha256").update(sub.endpoint).digest("hex"),
      createdAt: NOW,
    });
    expect(await w.deliver()).toEqual({ ok: true });
    expect(
      (await w.repos.pushSubscriptions.getById("psub_private"))?.disabledAt,
    ).toBeDefined();
  });

  it("retires nothing when the operator's signing identity fails", async () => {
    const repos = new MemoryRepositories();
    const adapter = createWebPushAdapter({
      vapidPublicKey: vapid.publicKey,
      vapidPrivateKey: vapid.privateKey,
      vapidSubject: "mailto:ops@example.test",
      fetchImpl: async () => new Response(null, { status: 201 }),
      now: () => {
        throw new Error("signing unavailable");
      },
    });
    const channel = createWebPushChannel({
      adapter,
      subscriptions: repos.pushSubscriptions,
    });
    const sub = mintPushSubscription();
    await repos.pushSubscriptions.create({
      id: "psub_ok",
      principalId: PRINCIPAL,
      endpoint: sub.endpoint,
      p256dhKey: sub.keys.p256dh,
      authSecret: sub.keys.auth,
      endpointDigest: createHash("sha256").update(sub.endpoint).digest("hex"),
      createdAt: NOW,
    });
    const payload = channel.render({
      eventType: "authority.invocation.requested",
      notificationClass: "authorization_request",
      confidentiality: "minimal",
      payload: { authReqId: "areq_1" },
    });
    const outcome = await channel.deliver({
      delivery: {
        id: "ndl_2",
        principalId: PRINCIPAL,
        kind: "native_push",
        notificationClass: "authorization_request",
        eventType: "authority.invocation.requested",
        outboxEventId: "obx_2",
        payload,
        confidentiality: "minimal",
        state: "pending",
        attempts: 1,
        nextAttemptAt: NOW,
        createdAt: NOW,
      },
      now: NOW,
    });
    expect(outcome).toEqual({
      ok: false,
      retryable: false,
      error: "vapid_signing_failed",
    });
    expect(
      await repos.pushSubscriptions.listForPrincipal(PRINCIPAL),
    ).toHaveLength(1);
  });
});
