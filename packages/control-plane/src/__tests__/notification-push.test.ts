import type { RegisterPushSubscription } from "@opensesame/contracts";
import { mintPushSubscription } from "@opensesame/notification-adapters/test-support";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { type App, authed, plane, principal } from "./notification-kit.js";

async function register(
  app: App,
  token: string,
  body: RegisterPushSubscription,
) {
  return app.request("/v1/notification-channels/push/subscriptions", {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify(body),
  });
}

function unsubscribe(app: App, token: string, id: string) {
  return app.request(`/v1/notification-channels/push/subscriptions/${id}`, {
    method: "DELETE",
    headers: authed(token),
  });
}

describe("web push key and enrolment", () => {
  it("contract: the VAPID key is public, and absent when nothing is configured", async () => {
    const { app } = plane();
    const me = await principal(app);
    expect(
      (
        await app.request("/v1/notification-channels/push/key", {
          headers: authed(me.accessToken),
        })
      ).status,
    ).toBe(404);

    const configured = plane({ notifications: { pushPublicKey: "BPubKey" } });
    const them = await principal(configured.app);
    const res = await configured.app.request(
      "/v1/notification-channels/push/key",
      { headers: authed(them.accessToken) },
    );
    expect(overlapCast(await res.json()).publicKey).toBe("BPubKey");
  });

  it("adversarial: the endpoint goes in and never comes back out", async () => {
    const { app, ctx } = plane({ notifications: { pushPublicKey: "BPubKey" } });
    const me = await principal(app);
    const sub = mintPushSubscription();
    const endpoint = sub.endpoint;
    const res = await app.request(
      "/v1/notification-channels/push/subscriptions",
      {
        method: "POST",
        headers: authed(me.accessToken),
        body: JSON.stringify({
          endpoint,
          keys: sub.keys,
          deviceLabel: "Alice's phone",
        }),
      },
    );
    expect(res.status).toBe(201);
    const raw = await res.text();
    // The endpoint is a capability URL: anyone holding it can push to that
    // browser. It is stored, and it is never echoed or logged.
    expect(raw).not.toContain(endpoint);
    expect(raw).not.toContain(sub.keys.auth);
    expect(raw).toContain("Alice's phone");

    const events = await ctx.repos.auditEvents.list({ limit: 50 });
    expect(JSON.stringify(events)).not.toContain(endpoint);

    const id = overlapCast(JSON.parse(raw)).id;
    const gone = await app.request(
      `/v1/notification-channels/push/subscriptions/${id}`,
      { method: "DELETE", headers: authed(me.accessToken) },
    );
    expect(gone.status).toBe(204);
  });
});

describe("web push ownership", () => {
  it("adversarial: another principal cannot take over a registered endpoint", async () => {
    const { app, ctx } = plane({ notifications: { pushPublicKey: "BPubKey" } });
    const alice = await principal(app);
    const mallory = await principal(app);
    const sub = mintPushSubscription();
    const owned = await register(app, alice.accessToken, {
      endpoint: sub.endpoint,
      keys: sub.keys,
      deviceLabel: "Alice's phone",
    });
    expect(owned.status).toBe(201);
    const id = overlapCast(await owned.json()).id;

    // Mallory knows the capability URL and presents it with keys of her own.
    const hers = mintPushSubscription();
    const stolen = await register(app, mallory.accessToken, {
      endpoint: sub.endpoint,
      keys: hers.keys,
      deviceLabel: "Mallory's phone",
    });
    expect(stolen.status).toBe(409);
    expect(await stolen.json()).toEqual({
      error: "endpoint_already_registered",
    });

    // Nothing moved: Alice's row is still Alice's, with Alice's keys and
    // label, and Mallory has no destination at all.
    const row = await ctx.repos.pushSubscriptions.getById(id);
    expect(row?.principalId).toBe(alice.principalId);
    expect(row?.p256dhKey).toBe(sub.keys.p256dh);
    expect(row?.deviceLabel).toBe("Alice's phone");
    expect(
      await ctx.repos.pushSubscriptions.listForPrincipal(mallory.principalId),
    ).toEqual([]);

    // Mallory cannot retire it either; Alice can.
    expect((await unsubscribe(app, mallory.accessToken, id)).status).toBe(404);
    expect((await unsubscribe(app, alice.accessToken, id)).status).toBe(204);
  });

  it("contract: the owner re-registering the same endpoint replaces in place", async () => {
    const { app, ctx } = plane({ notifications: { pushPublicKey: "BPubKey" } });
    const alice = await principal(app);
    const sub = mintPushSubscription();
    const first = overlapCast(
      await (
        await register(app, alice.accessToken, {
          endpoint: sub.endpoint,
          keys: sub.keys,
        })
      ).json(),
    );
    const fresh = mintPushSubscription();
    const again = await register(app, alice.accessToken, {
      endpoint: sub.endpoint,
      keys: fresh.keys,
    });
    expect(again.status).toBe(201);
    expect(overlapCast(await again.json()).id).toBe(first.id);
    const live = await ctx.repos.pushSubscriptions.listForPrincipal(
      alice.principalId,
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.p256dhKey).toBe(fresh.keys.p256dh);
  });

  it("contract: a browser changes hands once its first owner has unsubscribed", async () => {
    const { app, ctx } = plane({ notifications: { pushPublicKey: "BPubKey" } });
    const alice = await principal(app);
    const bob = await principal(app);
    const sub = mintPushSubscription();
    const id = overlapCast(
      await (
        await register(app, alice.accessToken, {
          endpoint: sub.endpoint,
          keys: sub.keys,
        })
      ).json(),
    ).id;
    await unsubscribe(app, alice.accessToken, id);
    const next = await register(app, bob.accessToken, {
      endpoint: sub.endpoint,
      keys: sub.keys,
    });
    expect(next.status).toBe(201);
    expect(
      await ctx.repos.pushSubscriptions.listForPrincipal(bob.principalId),
    ).toHaveLength(1);
    expect(
      await ctx.repos.pushSubscriptions.listForPrincipal(alice.principalId),
    ).toEqual([]);
  });
});

describe("validation: a subscription that could never be delivered is refused", () => {
  const valid = mintPushSubscription();
  const point = valid.ecdh.getPublicKey();
  const keys = (p256dh: string, auth: string = valid.keys.auth) => ({
    keys: { p256dh, auth },
  });
  const cases: Array<[string, Partial<RegisterPushSubscription>]> = [
    ["http endpoint", { endpoint: "http://push.example.test/send/x" }],
    ["loopback endpoint", { endpoint: "https://127.0.0.1/send/x" }],
    ["localhost endpoint", { endpoint: "https://localhost/send/x" }],
    ["private endpoint", { endpoint: "https://10.1.2.3/send/x" }],
    ["metadata endpoint", { endpoint: "https://169.254.169.254/x" }],
    ["userinfo endpoint", { endpoint: "https://u:p@push.example.test/x" }],
    ["not a URL", { endpoint: "not a url" }],
    ["short p256dh", keys(point.subarray(0, 33).toString("base64url"))],
    [
      "compressed p256dh",
      keys(
        Buffer.concat([Buffer.from([0x02]), point.subarray(1, 33)]).toString(
          "base64url",
        ),
      ),
    ],
    [
      "p256dh not on the curve",
      keys(
        Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString(
          "base64url",
        ),
      ),
    ],
    ["standard base64 p256dh", keys(point.toString("base64"))],
    [
      "short auth",
      keys(valid.keys.p256dh, Buffer.alloc(15, 1).toString("base64url")),
    ],
    [
      "long auth",
      keys(valid.keys.p256dh, Buffer.alloc(17, 1).toString("base64url")),
    ],
  ];
  it.each(cases)(
    "%s answers 400 invalid_request and stores nothing",
    async (_name, override) => {
      const { app, ctx } = plane({
        notifications: { pushPublicKey: "BPubKey" },
      });
      const me = await principal(app);
      const sub = mintPushSubscription();
      const res = await register(app, me.accessToken, {
        endpoint: sub.endpoint,
        keys: sub.keys,
        ...override,
      });
      expect(res.status).toBe(400);
      expect(overlapCast(await res.json()).error).toBe("invalid_request");
      expect(
        await ctx.repos.pushSubscriptions.listForPrincipal(me.principalId),
      ).toEqual([]);
    },
  );
});
