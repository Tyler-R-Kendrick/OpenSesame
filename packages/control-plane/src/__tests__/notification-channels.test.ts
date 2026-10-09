import type { NotificationChannelKind } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { type App, authed, plane, principal } from "./notification-kit.js";

/**
 * Channels, bindings and preferences (ADR 0084).
 *
 * The properties under test are the ones a settings screen can quietly break:
 * a provider subject that leaks into a list, a destination added without a
 * recent authentication, a preference that widens what policy allows, and a
 * screen that claims a channel works when no adapter is configured.
 */

/** Add a Slack destination the way the settings screen does. */
async function bind(
  app: App,
  token: string,
  hint = "T_ACME/U_ALICE",
): Promise<string> {
  const begun = await app.request("/v1/notification-channels/bindings", {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify({
      kind: "slack",
      displayLabel: "Acme workspace",
      destinationHint: hint,
    }),
  });
  expect(begun.status).toBe(201);
  const { challengeId, nonce } = overlapCast(await begun.json());
  const done = await app.request(
    "/v1/notification-channels/bindings/complete",
    {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify({ challengeId, nonce }),
    },
  );
  expect(done.status).toBe(201);
  return overlapCast(await done.json()).id;
}

describe("the channel catalogue", () => {
  it("contract: capabilities are the server's, and `configured` is separate from them", async () => {
    const { app } = plane();
    const me = await principal(app);
    const res = await app.request("/v1/notification-channels", {
      headers: authed(me.accessToken),
    });
    expect(res.status).toBe(200);
    const channels = overlapCast(await res.json()).channels;
    const byKind = new Map<NotificationChannelKind, JsonLike>(
      channels.map((c: JsonLike) => [c.kind, c]),
    );
    // The inbox is the authority and is never "unconfigured".
    expect(byKind.get("in_app")?.configured).toBe(true);
    expect(byKind.get("in_app")?.canSatisfyPhishingResistance).toBe(true);
    // No adapter for Telegram on this deployment, however capable Telegram is.
    expect(byKind.get("telegram")?.configured).toBe(false);
    expect(byKind.get("slack")?.configured).toBe(true);
    // And no channel claims a property physics does not give it.
    for (const kind of ["slack", "telegram", "sms", "native_push"] as const) {
      expect(byKind.get(kind)?.canSatisfyPhishingResistance).toBe(false);
    }
  });
});

type JsonLike = ReturnType<typeof overlapCast>;

describe("channel bindings", () => {
  it("contract: a binding is listed by its owner, and never carries the provider subject", async () => {
    const { app } = plane();
    const me = await principal(app);
    await bind(app, me.accessToken, "T_ACME/U_ALICE");

    const res = await app.request("/v1/notification-channels/bindings", {
      headers: authed(me.accessToken),
    });
    const raw = await res.text();
    // The subject is the value a forged callback would need to claim. It is
    // absent from the schema, so it cannot leak by a field being added later.
    expect(raw).not.toContain("U_ALICE");
    expect(raw).toContain("Acme workspace");
  });

  it("adversarial: adding a destination needs a recent authentication", async () => {
    let now = new Date("2026-08-19T12:00:00.000Z");
    const { app } = plane({ clock: () => now });
    const me = await principal(app);
    // An hour-old tab is not a step-up. Where a channel is opted in, the
    // bound subject is who may settle a decision from it, so a stale session
    // must not be able to add one.
    now = new Date(now.getTime() + 3_600_000);
    const res = await app.request("/v1/notification-channels/bindings", {
      method: "POST",
      headers: authed(me.accessToken),
      body: JSON.stringify({ kind: "slack", destinationHint: "T/U" }),
    });
    expect(res.status).toBe(403);
    expect(overlapCast(await res.json()).error).toBe("step_up_required");
  });

  it("adversarial: the nonce is checked against a durable budget, and is never stored", async () => {
    const { app } = plane();
    const me = await principal(app);
    const begun = await app.request("/v1/notification-channels/bindings", {
      method: "POST",
      headers: authed(me.accessToken),
      body: JSON.stringify({ kind: "slack", destinationHint: "T_ACME/U_BOB" }),
    });
    const { challengeId, nonce } = overlapCast(await begun.json());

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await app.request(
        "/v1/notification-channels/bindings/complete",
        {
          method: "POST",
          headers: authed(me.accessToken),
          body: JSON.stringify({ challengeId, nonce: `${nonce}-wrong` }),
        },
      );
      statuses.push(res.status);
    }
    expect(statuses).toContain(401);
    // The budget runs out, and the correct nonce cannot revive it.
    expect(statuses).toContain(429);
    const late = await app.request(
      "/v1/notification-channels/bindings/complete",
      {
        method: "POST",
        headers: authed(me.accessToken),
        body: JSON.stringify({ challengeId, nonce }),
      },
    );
    expect(late.status).toBe(429);
  });

  it("adversarial: a completion cannot be replayed into a second binding", async () => {
    const { app } = plane();
    const me = await principal(app);
    const begun = await app.request("/v1/notification-channels/bindings", {
      method: "POST",
      headers: authed(me.accessToken),
      body: JSON.stringify({ kind: "slack", destinationHint: "T_ACME/U_BOB" }),
    });
    const { challengeId, nonce } = overlapCast(await begun.json());
    const body = JSON.stringify({ challengeId, nonce });
    expect(
      (
        await app.request("/v1/notification-channels/bindings/complete", {
          method: "POST",
          headers: authed(me.accessToken),
          body,
        })
      ).status,
    ).toBe(201);
    const again = await app.request(
      "/v1/notification-channels/bindings/complete",
      { method: "POST", headers: authed(me.accessToken), body },
    );
    expect(again.status).toBe(409);
  });

  it("adversarial: a self-asserted identity is refused where the deployment says so", async () => {
    const { app } = plane({
      notifications: { allowSelfAssertedBindings: false },
    });
    const me = await principal(app);
    const begun = await app.request("/v1/notification-channels/bindings", {
      method: "POST",
      headers: authed(me.accessToken),
      body: JSON.stringify({ kind: "slack", destinationHint: "T_ACME/U_EVE" }),
    });
    const { challengeId, nonce } = overlapCast(await begun.json());
    const done = await app.request(
      "/v1/notification-channels/bindings/complete",
      {
        method: "POST",
        headers: authed(me.accessToken),
        body: JSON.stringify({ challengeId, nonce }),
      },
    );
    // The browser asking for the binding does not get to say whose Slack
    // account it is. Production waits for the provider round-trip.
    expect(done.status).toBe(403);
    expect(overlapCast(await done.json()).error).toBe(
      "provider_verification_required",
    );
  });

  it("adversarial: somebody else's binding answers 404, not 403", async () => {
    const { app } = plane();
    const owner = await principal(app);
    const stranger = await principal(app);
    const bindingId = await bind(app, owner.accessToken);
    const res = await app.request(
      `/v1/notification-channels/bindings/${bindingId}`,
      { method: "DELETE", headers: authed(stranger.accessToken) },
    );
    expect(res.status).toBe(404);
  });

  it("contract: revoking is audited and leaves the destination unusable", async () => {
    const { app, ctx } = plane();
    const me = await principal(app);
    const bindingId = await bind(app, me.accessToken);
    const res = await app.request(
      `/v1/notification-channels/bindings/${bindingId}`,
      { method: "DELETE", headers: authed(me.accessToken) },
    );
    expect(res.status).toBe(200);
    expect(overlapCast(await res.json()).state).toBe("revoked");
    const events = await ctx.repos.auditEvents.list({ limit: 50 });
    expect(events.map((e) => e.eventType)).toContain(
      "notification.binding.revoked",
    );
    // Nothing in the trail names the subject.
    expect(JSON.stringify(events)).not.toContain("U_ALICE");
  });
});

describe("preferences and the effective route", () => {
  it("contract: a preference is stored as asked, and narrowed only when it is read", async () => {
    const { app } = plane();
    const me = await principal(app);
    const saved = await app.request("/v1/notification-preferences", {
      method: "PUT",
      headers: authed(me.accessToken),
      body: JSON.stringify({
        byClass: {
          authorization_request: {
            channels: ["telegram", "slack", "in_app"],
            fanOut: false,
          },
        },
      }),
    });
    expect(saved.status).toBe(200);
    // Stored verbatim: the intersection happens at routing time, so a
    // preference recorded before an operator narrowed a policy cannot survive
    // that narrowing by having been validated once.
    const read = await app.request("/v1/notification-preferences", {
      headers: authed(me.accessToken),
    });
    expect(
      overlapCast(await read.json()).byClass.authorization_request.channels,
    ).toEqual(["telegram", "slack", "in_app"]);

    const effective = await app.request(
      "/v1/notification-preferences/effective?class=authorization_request",
      { headers: authed(me.accessToken) },
    );
    const plan = overlapCast(await effective.json());
    // Telegram has no adapter here; Slack has one but no binding. Both are
    // reported rather than silently dropped — a screen that shows only what
    // survived is a screen that lies quietly.
    const reasons = new Map<string, string>(
      plan.excluded.map((e: JsonLike) => [e.kind, e.reason]),
    );
    expect(reasons.get("telegram")).toBe("adapter_unavailable");
    expect(reasons.get("slack")).toBe("no_active_binding");
    // The inbox is always the last step, whatever else failed.
    expect(plan.steps.at(-1)?.kind).toBe("in_app");
    expect(plan.steps.at(-1)?.mode).toBe("interactive");
  });

  it("contract: a live binding turns a preference into a real step", async () => {
    const { app } = plane();
    const me = await principal(app);
    await bind(app, me.accessToken);
    await app.request("/v1/notification-preferences", {
      method: "PUT",
      headers: authed(me.accessToken),
      body: JSON.stringify({
        byClass: {
          authorization_request: { channels: ["slack"], fanOut: false },
        },
      }),
    });
    const effective = await app.request(
      "/v1/notification-preferences/effective",
      { headers: authed(me.accessToken) },
    );
    const plan = overlapCast(await effective.json());
    const slack = plan.steps.find((s: JsonLike) => s.kind === "slack");
    expect(slack).toBeTruthy();
    // Rendezvous, not interactive: this deployment opted no channel in to
    // direct settlement, so Slack may point at the ceremony and no more.
    expect(slack?.mode).toBe("rendezvous");
    expect(slack?.confidentiality).toBe("descriptive");
  });
});
