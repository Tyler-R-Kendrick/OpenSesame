import { createHash } from "node:crypto";
import type { RegisterPushSubscription } from "@opensesame/contracts";
import { mintPushSubscription } from "@opensesame/notification-adapters/test-support";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL } from "../routes/push-enrolment.js";
import { type App, authed, plane, principal } from "./notification-kit.js";

/**
 * Who may hold how many subscriptions, and which spellings of an endpoint are
 * the same one. The subscriptions a worker pushes to are the work it waits on,
 * and the digest an ownership claim keys on is only as strong as the
 * canonical form behind it.
 */

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function enrol(app: App, token: string, body: RegisterPushSubscription) {
  return app.request("/v1/notification-channels/push/subscriptions", {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify(body),
  });
}

function setup() {
  return plane({ notifications: { pushPublicKey: "BPubKey" } });
}

describe("the per-principal subscription cap", () => {
  const max = MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL;

  it("refuses the subscription past the cap with a stable code, and stores nothing", async () => {
    const { app, ctx } = setup();
    const me = await principal(app);
    for (let index = 0; index < max; index += 1) {
      const sub = mintPushSubscription();
      expect(
        (
          await enrol(app, me.accessToken, {
            endpoint: sub.endpoint,
            keys: sub.keys,
          })
        ).status,
      ).toBe(201);
    }
    const extra = mintPushSubscription();
    const refused = await enrol(app, me.accessToken, {
      endpoint: extra.endpoint,
      keys: extra.keys,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "subscription_limit_reached",
    });
    expect(
      await ctx.repos.pushSubscriptions.listForPrincipal(me.principalId),
    ).toHaveLength(max);
    expect(
      await ctx.repos.pushSubscriptions.findByEndpointDigest(
        sha256(extra.endpoint),
      ),
    ).toBeNull();
  });

  it("does not count a replacement, and frees a slot when one is unsubscribed", async () => {
    const { app, ctx } = setup();
    const me = await principal(app);
    const first = mintPushSubscription();
    const firstId = overlapCast(
      await (
        await enrol(app, me.accessToken, {
          endpoint: first.endpoint,
          keys: first.keys,
        })
      ).json(),
    ).id;
    for (let index = 1; index < max; index += 1) {
      const sub = mintPushSubscription();
      await enrol(app, me.accessToken, {
        endpoint: sub.endpoint,
        keys: sub.keys,
      });
    }
    // At the cap, re-subscribing the browser already held is still allowed.
    const fresh = mintPushSubscription();
    expect(
      (
        await enrol(app, me.accessToken, {
          endpoint: first.endpoint,
          keys: fresh.keys,
        })
      ).status,
    ).toBe(201);
    const extra = mintPushSubscription();
    expect(
      (
        await enrol(app, me.accessToken, {
          endpoint: extra.endpoint,
          keys: extra.keys,
        })
      ).status,
    ).toBe(409);

    await app.request(
      `/v1/notification-channels/push/subscriptions/${firstId}`,
      {
        method: "DELETE",
        headers: authed(me.accessToken),
      },
    );
    expect(
      (
        await enrol(app, me.accessToken, {
          endpoint: extra.endpoint,
          keys: extra.keys,
        })
      ).status,
    ).toBe(201);
    expect(
      await ctx.repos.pushSubscriptions.listForPrincipal(me.principalId),
    ).toHaveLength(max);
  });

  it("never lets concurrent registrations exceed it", async () => {
    const { app, ctx } = setup();
    const me = await principal(app);
    const subs = Array.from({ length: max * 3 }, () => mintPushSubscription());
    await Promise.all(
      subs.map((sub) =>
        enrol(app, me.accessToken, { endpoint: sub.endpoint, keys: sub.keys }),
      ),
    );
    expect(
      (await ctx.repos.pushSubscriptions.listForPrincipal(me.principalId))
        .length,
    ).toBeLessThanOrEqual(max);
  });

  it("is per principal: one person at the cap does not block another", async () => {
    const { app } = setup();
    const full = await principal(app);
    const other = await principal(app);
    for (let index = 0; index < max; index += 1) {
      const sub = mintPushSubscription();
      await enrol(app, full.accessToken, {
        endpoint: sub.endpoint,
        keys: sub.keys,
      });
    }
    const sub = mintPushSubscription();
    expect(
      (
        await enrol(app, other.accessToken, {
          endpoint: sub.endpoint,
          keys: sub.keys,
        })
      ).status,
    ).toBe(201);
  });
});

describe("one spelling per endpoint", () => {
  it("does not let a differently written copy of a live endpoint past its owner", async () => {
    const { app, ctx } = setup();
    const alice = await principal(app);
    const mallory = await principal(app);
    const sub = mintPushSubscription();
    await enrol(app, alice.accessToken, {
      endpoint: sub.endpoint,
      keys: sub.keys,
    });

    const url = new URL(sub.endpoint);
    const variants = [
      `https://${url.host.toUpperCase()}${url.pathname}`,
      `https://${url.host}:443${url.pathname}`,
      `${sub.endpoint}#fragment`,
      `https://${url.host}.${url.pathname}`,
    ];
    for (const endpoint of variants) {
      const res = await enrol(app, mallory.accessToken, {
        endpoint,
        keys: mintPushSubscription().keys,
      });
      expect(res.status, endpoint).toBe(409);
    }
    expect(
      await ctx.repos.pushSubscriptions.listForPrincipal(mallory.principalId),
    ).toEqual([]);
  });

  it("treats the owner's differently written copy as the same subscription", async () => {
    const { app, ctx } = setup();
    const alice = await principal(app);
    const sub = mintPushSubscription();
    await enrol(app, alice.accessToken, {
      endpoint: sub.endpoint,
      keys: sub.keys,
    });
    const url = new URL(sub.endpoint);
    const again = await enrol(app, alice.accessToken, {
      endpoint: `https://${url.host.toUpperCase()}:443${url.pathname}#x`,
      keys: mintPushSubscription().keys,
    });
    expect(again.status).toBe(201);
    const live = await ctx.repos.pushSubscriptions.listForPrincipal(
      alice.principalId,
    );
    expect(live).toHaveLength(1);
    // What is stored, and what a push is sent to, is the canonical spelling.
    expect(live[0]?.endpoint).toBe(sub.endpoint);
  });

  it("keeps rows written before normalization working, and carries the owner's over", async () => {
    const { app, ctx } = setup();
    const alice = await principal(app);
    const mallory = await principal(app);
    const sub = mintPushSubscription();
    // An older row, keyed on the raw string a browser once presented.
    const raw = `https://${new URL(sub.endpoint).host.toUpperCase()}${new URL(sub.endpoint).pathname}`;
    const legacy = await ctx.repos.pushSubscriptions.create({
      id: "push_legacy",
      principalId: alice.principalId,
      endpoint: raw,
      p256dhKey: sub.keys.p256dh,
      authSecret: sub.keys.auth,
      endpointDigest: sha256(raw),
      createdAt: new Date(),
    });

    // Someone else presenting that exact spelling does not take it.
    const stolen = await enrol(app, mallory.accessToken, {
      endpoint: raw,
      keys: mintPushSubscription().keys,
    });
    expect(stolen.status).toBe(409);
    expect(
      (await ctx.repos.pushSubscriptions.getById(legacy.id))?.disabledAt,
    ).toBeUndefined();

    // The owner re-registering moves to the canonical row; the old one retires,
    // so one browser is not rung twice.
    const moved = await enrol(app, alice.accessToken, {
      endpoint: raw,
      keys: sub.keys,
    });
    expect(moved.status).toBe(201);
    expect(
      (await ctx.repos.pushSubscriptions.getById(legacy.id))?.disabledAt,
    ).toBeDefined();
    const live = await ctx.repos.pushSubscriptions.listForPrincipal(
      alice.principalId,
    );
    expect(live.map((row) => row.endpoint)).toEqual([sub.endpoint]);
  });
});

describe("unsubscribing is decided by the owner in the write", () => {
  it("answers 404 and leaves the new holder's row live once the endpoint changed hands", async () => {
    const { app, ctx } = setup();
    const alice = await principal(app);
    const bob = await principal(app);
    const sub = mintPushSubscription();
    const id = overlapCast(
      await (
        await enrol(app, alice.accessToken, {
          endpoint: sub.endpoint,
          keys: sub.keys,
        })
      ).json(),
    ).id;
    const drop = (token: string) =>
      app.request(`/v1/notification-channels/push/subscriptions/${id}`, {
        method: "DELETE",
        headers: authed(token),
      });
    expect((await drop(alice.accessToken)).status).toBe(204);
    await enrol(app, bob.accessToken, {
      endpoint: sub.endpoint,
      keys: sub.keys,
    });

    // Alice, still holding the id, retries: Bob's revived row is not hers.
    expect((await drop(alice.accessToken)).status).toBe(404);
    expect(
      (await ctx.repos.pushSubscriptions.getById(id))?.disabledAt,
    ).toBeUndefined();
    // Bob unsubscribing his own row, and again, is an idempotent 204.
    expect((await drop(bob.accessToken)).status).toBe(204);
    expect((await drop(bob.accessToken)).status).toBe(204);
  });
});
