import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type App = ReturnType<typeof createControlPlane>["app"];

function plane() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  });
}

async function principal(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

let seq = 0;
async function register(
  app: App,
  token: string,
  url = "https://hooks.example.test/a",
) {
  return app.request("/v1/webhooks", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": `hook-${++seq}`,
    },
    body: JSON.stringify({ url }),
  });
}

describe("webhook endpoint registration", () => {
  it("contract: register shows the secret once; listing masks it", async () => {
    const { app } = plane();
    const owner = await principal(app);
    const created = await register(app, owner.accessToken);
    expect(created.status).toBe(201);
    const body = overlapCast(await created.json());
    expect(body.secret.startsWith("whsec_")).toBe(true);

    const listed = await app.request("/v1/webhooks", {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const { endpoints } = overlapCast(await listed.json());
    expect(endpoints).toHaveLength(1);
    // A read scope must not be a forgery kit: the usable secret appeared
    // exactly once, at registration.
    expect(endpoints[0]?.secret).not.toBe(body.secret);
    expect(endpoints[0]?.secret.startsWith("whsec_")).toBe(true);
  });

  it("adversarial: plain-http receivers are refused", async () => {
    // The payload names authorization requests; an eavesdroppable receiver
    // would leak what is pending to anyone on the path.
    const { app } = plane();
    const owner = await principal(app);
    const res = await register(
      app,
      owner.accessToken,
      "http://hooks.example.test/a",
    );
    expect(res.status).toBe(400);
  });

  it("adversarial: someone else's endpoint is 404, delete included", async () => {
    const { app } = plane();
    const owner = await principal(app);
    const stranger = await principal(app);
    const created = await register(app, owner.accessToken);
    const { id } = overlapCast(await created.json());

    const listed = await app.request("/v1/webhooks", {
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    const { endpoints } = overlapCast(await listed.json());
    expect(endpoints).toHaveLength(0);

    const deleted = await app.request(`/v1/webhooks/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(deleted.status).toBe(404);

    const own = await app.request(`/v1/webhooks/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(own.status).toBe(204);
  });

  it("contract: inbox activity lands in the outbox for the dispatcher", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const refRes = await app.request("/v1/authorization-requests/inbox-ref", {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    const { approverRef } = overlapCast(await refRes.json());

    const asked = await app.request("/v1/authorization-requests", {
      method: "POST",
      headers: {
        authorization: `Bearer ${requester.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": `hook-ask-${++seq}`,
      },
      body: JSON.stringify({
        approverRef,
        bindingMessage: "Read acme/catalog issues",
        // Read-only actions, so the risk classifier lands on the lax end of
        // the ladder (ADR 0081) and this stays a test about the outbox rather
        // than about the approval ceremony.
        authorizationDetails: [
          { type: "connection_delegation", actions: ["repository.read"] },
        ],
      }),
    });
    expect(asked.status).toBe(201);
    const { authReqId, requestDigest } = overlapCast(await asked.json());

    const decided = await app.request(
      `/v1/authorization-requests/${authReqId}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestDigest }),
      },
    );
    expect(decided.status).toBe(200);

    const pending = await ctx.repos.outbox.listUnpublished();
    const types = pending.map((event) => event.eventType);
    expect(types).toContain("authority.invocation.requested");
    expect(types).toContain("authority.invocation.completed");
    // The rows carry the routing key and digests — never the binding message
    // text, which is requester-authored.
    for (const event of pending) {
      expect(JSON.stringify(event.payload)).not.toContain("acme/catalog");
    }
  });
});
