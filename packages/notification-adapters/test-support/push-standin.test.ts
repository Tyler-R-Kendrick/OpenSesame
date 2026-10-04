import { afterEach, describe, expect, it } from "vitest";

import {
  createWebPushAdapter,
  encryptWebPushPayload,
  generateVapidKeyPair,
  vapidAuthorization,
} from "../src/index.js";
import type { RenderInput } from "../src/index.js";
import {
  type PushStandIn,
  mintPushSubscription,
  startPushStandIn,
  wakePayloadViolation,
} from "./index.js";

/**
 * The adapter against the stand-in push service, end to end over HTTP: the
 * adapter encrypts and signs, the stand-in verifies with `jws` and `http_ece`.
 * It also proves the stand-in itself can say no, because a service that
 * accepts everything would make every other test that uses it meaningless.
 */

const RENDER: RenderInput = {
  kind: "native_push",
  confidentiality: "full",
  notificationClass: "authorization_request",
  eventType: "authority.invocation.requested",
  rendezvousRef: "areq_01HZZ-abc",
  rendezvousUrl: "https://os.example/approve/areq_01HZZ-abc",
  bindingMessage: "Transfer funds to account ending 4417",
  actionLabel: "payment.initiate",
};

let standIn: PushStandIn | undefined;
afterEach(async () => {
  await standIn?.close();
  standIn = undefined;
});

async function setup(contract = true) {
  const vapid = generateVapidKeyPair();
  standIn = await startPushStandIn({
    vapidPublicKey: vapid.publicKey,
    contract,
  });
  const adapter = createWebPushAdapter({
    vapidPublicKey: vapid.publicKey,
    vapidPrivateKey: vapid.privateKey,
    vapidSubject: "mailto:ops@example.test",
    fetchImpl: standIn.fetchImpl,
  });
  return { vapid, adapter, standIn };
}

describe("stand-in push service", () => {
  it("accepts an adapter push, and what it decrypts is the closed vocabulary", async () => {
    const { adapter, standIn: service, vapid } = await setup();
    const sub = service.mint();
    const arrival = service.next(5000);
    const outcome = await adapter.deliver(adapter.render(RENDER), {
      channel: "native_push",
      subscription: { endpoint: sub.endpoint, keys: sub.keys },
    });
    expect(outcome).toEqual({ status: "delivered" });
    const push = await arrival;
    expect(push.json).toEqual({
      kind: "authorization_request",
      action: "review",
      ref: "areq_01HZZ-abc",
    });
    expect(push.subscriptionId).toBe(sub.id);
    expect(push.vapid.publicKey).toBe(vapid.publicKey);
    expect(push.vapid.claims.aud).toBe(service.publicOrigin);
    expect(push.vapid.claims.sub).toBe("mailto:ops@example.test");
    // None of what the requester wrote reached the push service, even
    // encrypted: the payload is built from the closed vocabulary alone.
    expect(push.payload).not.toContain("4417");
    expect(push.payload).not.toContain("payment.initiate");
    expect(push.payload).not.toContain("https://");
  });

  it("answers a gone subscription 404 or 410, which the adapter reads as permanent", async () => {
    const { adapter, standIn: service } = await setup();
    const sub = service.mint();
    const destination = {
      channel: "native_push" as const,
      subscription: { endpoint: sub.endpoint, keys: sub.keys },
    };
    const message = adapter.render(RENDER);

    service.respondWith(sub.id, 410);
    await expect(adapter.deliver(message, destination)).resolves.toEqual({
      status: "permanent",
      error: "status:410",
    });
    service.respondWith(sub.id, undefined);
    service.unregister(sub.id);
    await expect(adapter.deliver(message, destination)).resolves.toEqual({
      status: "permanent",
      error: "status:404",
    });
  });

  it("answers 503 for a forced try-again, and 201 once it is cleared", async () => {
    const { adapter, standIn: service } = await setup();
    const sub = service.mint();
    const destination = {
      channel: "native_push" as const,
      subscription: { endpoint: sub.endpoint, keys: sub.keys },
    };
    const message = adapter.render(RENDER);
    service.respondWith(sub.id, 503);
    await expect(adapter.deliver(message, destination)).resolves.toEqual({
      status: "retryable",
      error: "status:503",
    });
    service.respondWith(sub.id, undefined);
    await expect(adapter.deliver(message, destination)).resolves.toEqual({
      status: "delivered",
    });
  });

  it("refuses a push signed under a different application server key", async () => {
    const { standIn: service } = await setup();
    const other = generateVapidKeyPair();
    const stranger = createWebPushAdapter({
      vapidPublicKey: other.publicKey,
      vapidPrivateKey: other.privateKey,
      vapidSubject: "mailto:ops@example.test",
      fetchImpl: service.fetchImpl,
    });
    const sub = service.mint();
    await expect(
      stranger.deliver(stranger.render(RENDER), {
        channel: "native_push",
        subscription: { endpoint: sub.endpoint, keys: sub.keys },
      }),
    ).resolves.toEqual({ status: "permanent", error: "status:401" });
    expect(service.received.at(-1)).toMatchObject({
      ok: false,
      reason: "k_mismatch",
    });
  });

  it("sends only the closed vocabulary even when the message carries more", async () => {
    const { adapter, standIn: service } = await setup();
    const sub = service.mint();
    const message = adapter.render(RENDER);
    // A wake with a requester's text smuggled in beside the valid fields.
    const tampered = {
      ...message,
      wake: { ...message.wake, title: "Transfer funds" },
    } as typeof message;
    await expect(
      adapter.deliver(tampered, {
        channel: "native_push",
        subscription: { endpoint: sub.endpoint, keys: sub.keys },
      }),
    ).resolves.toEqual({ status: "delivered" });
    const last = service.received.at(-1);
    expect(last?.ok && Object.keys(last.json as object).sort()).toEqual([
      "action",
      "kind",
      "ref",
    ]);
  });

  it("answers 400 and says why when a correctly signed, correctly encrypted push breaks the contract", async () => {
    const { vapid, standIn: service } = await setup();
    const sub = service.mint();
    const post = (payload: object) =>
      service.fetchImpl(sub.endpoint, {
        method: "POST",
        headers: {
          authorization: vapidAuthorization(
            sub.endpoint,
            {
              vapidPublicKey: vapid.publicKey,
              vapidPrivateKey: vapid.privateKey,
              vapidSubject: "mailto:ops@example.test",
            },
            new Date(),
          ),
          "content-encoding": "aes128gcm",
          ttl: "60",
        },
        body: encryptWebPushPayload(
          { endpoint: sub.endpoint, keys: sub.keys },
          Buffer.from(JSON.stringify(payload)),
        ),
      });
    const response = await post({
      title: "Authorization requested",
      body: "Transfer funds",
      url: "https://os.example/approve/x",
    });
    expect(response.status).toBe(400);
    expect(service.received.at(-1)).toMatchObject({
      ok: false,
      status: 400,
      reason: expect.stringContaining("contract_violation:unexpected keys"),
    });
    expect(
      (await post({ kind: "security_event", action: "none", ref: "ok_1" }))
        .status,
    ).toBe(201);
  });

  it("states the vocabulary it enforces", () => {
    expect(
      wakePayloadViolation({ title: "x", body: "y", url: "https://z" }),
    ).toMatch(/unexpected keys/u);
    expect(wakePayloadViolation({ kind: "nope", action: "review" })).toMatch(
      /kind/u,
    );
    expect(
      wakePayloadViolation({
        kind: "security_event",
        action: "none",
        ref: "a/b",
      }),
    ).toMatch(/ref/u);
    expect(
      wakePayloadViolation({
        kind: "authorization_decision",
        action: "decided",
        ref: "areq_1",
      }),
    ).toBeUndefined();
  });

  it("is never reached for a loopback or http endpoint, however it is injected", async () => {
    const { adapter, standIn: service } = await setup();
    const sub = mintPushSubscription({ endpointOrigin: service.url });
    service.register(sub);
    await expect(
      adapter.deliver(adapter.render(RENDER), {
        channel: "native_push",
        subscription: { endpoint: sub.endpoint, keys: sub.keys },
      }),
    ).resolves.toEqual({ status: "permanent", error: "insecure_endpoint" });
    expect(service.received).toHaveLength(0);
  });
});
