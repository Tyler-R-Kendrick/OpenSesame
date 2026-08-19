import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type App = ReturnType<typeof createControlPlane>["app"];

function plane(): App {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  }).app;
}

async function principal(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { principalId: string; accessToken: string };
}

let seq = 0;
async function ask(
  app: App,
  requesterToken: string,
  approverId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await app.request("/v1/authorization-requests", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requesterToken}`,
      "content-type": "application/json",
      "idempotency-key": `ask-${++seq}`,
    },
    body: JSON.stringify({
      principalId: approverId,
      bindingMessage: "Read acme/catalog issues",
      authorizationDetails: [
        {
          type: "connection_delegation",
          actions: ["repository.read"],
          locations: ["repo:acme/catalog"],
        },
      ],
      ...overrides,
    }),
  });
  return res;
}

const decide = (
  app: App,
  token: string,
  id: string,
  action: "approve" | "deny",
  digest: string,
) =>
  app.request(`/v1/authorization-requests/${id}/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestDigest: digest }),
  });

describe("authorization request inbox", () => {
  it("contract: a request is created, listed by its approver, and approved", async () => {
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);

    const created = await ask(app, requester.accessToken, approver.principalId);
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      authReqId: string;
      status: string;
      requestDigest: string;
      bindingMessage: string;
    };
    expect(body.status).toBe("pending");
    expect(body.bindingMessage).toBe("Read acme/catalog issues");

    const inbox = await app.request(
      "/v1/authorization-requests?status=pending",
      { headers: { authorization: `Bearer ${approver.accessToken}` } },
    );
    const listed = (await inbox.json()) as {
      requests: { authReqId: string }[];
    };
    expect(listed.requests.map((r) => r.authReqId)).toContain(body.authReqId);

    const approved = await decide(
      app,
      approver.accessToken,
      body.authReqId,
      "approve",
      body.requestDigest,
    );
    expect(approved.status).toBe(200);
    const settled = (await approved.json()) as {
      status: string;
      decidedByKind: string;
    };
    expect(settled.status).toBe("approved");
    expect(settled.decidedByKind).toBe("human");
  });

  it("adversarial: approving with a digest other than the one shown is refused", async () => {
    // The whole point of an approval. Without this, consent to one request
    // would authorize whatever the row happened to say later.
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const body = (await (
      await ask(app, requester.accessToken, approver.principalId)
    ).json()) as { authReqId: string };

    const res = await decide(
      app,
      approver.accessToken,
      body.authReqId,
      "approve",
      "0".repeat(64),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "digest_mismatch" });
  });

  it("adversarial: the requester cannot settle their own request", async () => {
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const body = (await (
      await ask(app, requester.accessToken, approver.principalId)
    ).json()) as { authReqId: string; requestDigest: string };

    const res = await decide(
      app,
      requester.accessToken,
      body.authReqId,
      "approve",
      body.requestDigest,
    );
    // 404, not 403: whether that id exists is itself not the requester's to learn.
    expect(res.status).toBe(404);
  });

  it("adversarial: a stranger cannot read or list someone else's request", async () => {
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const stranger = await principal(app);
    const body = (await (
      await ask(app, requester.accessToken, approver.principalId)
    ).json()) as { authReqId: string };

    const read = await app.request(
      `/v1/authorization-requests/${body.authReqId}`,
      { headers: { authorization: `Bearer ${stranger.accessToken}` } },
    );
    expect(read.status).toBe(404);

    const inbox = await app.request("/v1/authorization-requests", {
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect((await inbox.json()) as { requests: unknown[] }).toEqual({
      requests: [],
    });
  });

  it("contract: the requester may poll for an answer", async () => {
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const body = (await (
      await ask(app, requester.accessToken, approver.principalId)
    ).json()) as { authReqId: string };

    const poll = await app.request(
      `/v1/authorization-requests/${body.authReqId}/poll`,
      { headers: { authorization: `Bearer ${requester.accessToken}` } },
    );
    expect(poll.status).toBe(200);
    expect((await poll.json()).status).toBe("pending");
  });

  it("chaos: polling faster than the interval is slowed down, not served", async () => {
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const body = (await (
      await ask(app, requester.accessToken, approver.principalId)
    ).json()) as { authReqId: string };
    const url = `/v1/authorization-requests/${body.authReqId}/poll`;
    const auth = { authorization: `Bearer ${requester.accessToken}` };

    expect((await app.request(url, { headers: auth })).status).toBe(200);
    const second = await app.request(url, { headers: auth });
    expect(second.status).toBe(400);
    const slowed = (await second.json()) as {
      error: string;
      intervalSeconds: number;
    };
    expect(slowed.error).toBe("slow_down");
    // The pacing must actually back off, or "slow down" is only advice.
    expect(slowed.intervalSeconds).toBeGreaterThan(5);
  });

  it("adversarial: a decided request cannot be decided a second time", async () => {
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const body = (await (
      await ask(app, requester.accessToken, approver.principalId)
    ).json()) as { authReqId: string; requestDigest: string };

    expect(
      (
        await decide(
          app,
          approver.accessToken,
          body.authReqId,
          "approve",
          body.requestDigest,
        )
      ).status,
    ).toBe(200);
    const again = await decide(
      app,
      approver.accessToken,
      body.authReqId,
      "deny",
      body.requestDigest,
    );
    expect(again.status).toBe(422);
  });

  it("contract: asking an unknown principal answers 404 rather than confirming it", async () => {
    const app = plane();
    const requester = await principal(app);
    const res = await ask(app, requester.accessToken, "prn_does_not_exist");
    expect(res.status).toBe(404);
  });

  it("adversarial: the requester reference is opaque, never the caller's principal id", async () => {
    // This value reaches inboxes and, once relay lands, public bus subjects.
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const created = await ask(app, requester.accessToken, approver.principalId);
    const raw = await created.text();
    expect(raw).not.toContain(requester.principalId);
  });
});
