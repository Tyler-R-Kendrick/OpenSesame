import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

type App = ReturnType<typeof createControlPlane>["app"];

function plane(clock?: () => Date): App {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
    ...(clock ? { clock } : undefined),
  }).app;
}

/**
 * The approver's inbox handle.
 *
 * Only its owner can obtain it, which is the point: a raw principal id is not
 * an address, so a caller who merely knows who someone is cannot reach them.
 */
async function inboxRefOf(
  app: App,
  who: { accessToken: string },
): Promise<string> {
  const res = await app.request("/v1/authorization-requests/inbox-ref", {
    headers: { authorization: `Bearer ${who.accessToken}` },
  });
  expect(res.status).toBe(200);
  return (overlapCast(await res.json())).approverRef;
}

async function principal(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

let seq = 0;
async function ask(
  app: App,
  requesterToken: string,
  approverRef: string,
  overrides: JsonObject = {},
) {
  const res = await app.request("/v1/authorization-requests", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requesterToken}`,
      "content-type": "application/json",
      "idempotency-key": `ask-${++seq}`,
    },
    body: JSON.stringify({
      approverRef,
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

    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver),
    );
    expect(created.status).toBe(201);
    const body = overlapCast(await created.json());
    expect(body.status).toBe("pending");
    expect(body.bindingMessage).toBe("Read acme/catalog issues");

    const inbox = await app.request(
      "/v1/authorization-requests?status=pending",
      { headers: { authorization: `Bearer ${approver.accessToken}` } },
    );
    const listed = overlapCast(await inbox.json());
    expect(listed.requests.map((r) => r.authReqId)).toContain(body.authReqId);

    const approved = await decide(
      app,
      approver.accessToken,
      body.authReqId,
      "approve",
      body.requestDigest,
    );
    expect(approved.status).toBe(200);
    const settled = overlapCast(await approved.json());
    expect(settled.status).toBe("approved");
    expect(settled.decidedByKind).toBe("human");
  });

  it("adversarial: approving with a digest other than the one shown is refused", async () => {
    // The whole point of an approval. Without this, consent to one request
    // would authorize whatever the row happened to say later.
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const body = overlapCast(await (
      await ask(app, requester.accessToken, await inboxRefOf(app, approver))
    ).json());

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
    const body = overlapCast(await (
      await ask(app, requester.accessToken, await inboxRefOf(app, approver))
    ).json());

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
    const body = overlapCast(await (
      await ask(app, requester.accessToken, await inboxRefOf(app, approver))
    ).json());

    const read = await app.request(
      `/v1/authorization-requests/${body.authReqId}`,
      { headers: { authorization: `Bearer ${stranger.accessToken}` } },
    );
    expect(read.status).toBe(404);

    const inbox = await app.request("/v1/authorization-requests", {
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(overlapCast(await inbox.json())).toEqual({
      requests: [],
    });
  });

  it("contract: the requester may poll for an answer", async () => {
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const body = overlapCast(await (
      await ask(app, requester.accessToken, await inboxRefOf(app, approver))
    ).json());

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
    const body = overlapCast(await (
      await ask(app, requester.accessToken, await inboxRefOf(app, approver))
    ).json());
    const url = `/v1/authorization-requests/${body.authReqId}/poll`;
    const auth = { authorization: `Bearer ${requester.accessToken}` };

    expect((await app.request(url, { headers: auth })).status).toBe(200);
    const second = await app.request(url, { headers: auth });
    expect(second.status).toBe(400);
    const slowed = overlapCast(await second.json());
    expect(slowed.error).toBe("slow_down");
    // The pacing must actually back off, or "slow down" is only advice.
    expect(slowed.intervalSeconds).toBeGreaterThan(5);
  });

  it("adversarial: a decided request cannot be decided a second time", async () => {
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const body = overlapCast(await (
      await ask(app, requester.accessToken, await inboxRefOf(app, approver))
    ).json());

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
    const res = await ask(app, requester.accessToken, "inbox_bm9wZQ.deadbeef");
    expect(res.status).toBe(404);
  });

  it("adversarial: knowing a principal id is not an address for its inbox", async () => {
    // The whole reason the address is a handle. If a raw id worked here, then
    // anyone who learned an id could put text of their choosing in front of
    // that person, and the difference between 201 and 404 would answer, for
    // any id, whether it exists.
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);

    const byId = await ask(app, requester.accessToken, approver.principalId);
    expect(byId.status).toBe(404);

    // A handle whose MAC does not check out is refused the same way, so a
    // forged one and a nonexistent one are indistinguishable.
    const real = await inboxRefOf(app, approver);
    const [body] = real.slice("inbox_".length).split(".");
    const forged = `inbox_${body}.${"a".repeat(32)}`;
    expect((await ask(app, requester.accessToken, forged)).status).toBe(404);

    // And the real handle still works, so the refusals above are the fence
    // doing its job rather than the route being broken.
    expect((await ask(app, requester.accessToken, real)).status).toBe(201);
  });

  it("contract: a principal only ever gets its own inbox handle", async () => {
    const app = plane();
    const a = await principal(app);
    const b = await principal(app);
    expect(await inboxRefOf(app, a)).not.toBe(await inboxRefOf(app, b));
    // Stable, so it can be shared once rather than reissued per call.
    expect(await inboxRefOf(app, a)).toBe(await inboxRefOf(app, a));
    // And it does not simply carry the id in the clear.
    expect(await inboxRefOf(app, a)).not.toContain(a.principalId);
  });

  it("property: a lapsed request is expired in the store, not only on screen", async () => {
    // Display-only expiry leaves the row `pending` forever: it keeps its place
    // in a bounded inbox ahead of live requests, and nothing ever sheds it.
    let now = new Date("2026-08-19T12:00:00.000Z");
    const app = plane(() => now);
    const approver = await principal(app);
    const requester = await principal(app);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver),
      { ttlSeconds: 30 },
    );
    const { authReqId } = overlapCast(await created.json());

    now = new Date(now.getTime() + 60_000);
    const read = await app.request(`/v1/authorization-requests/${authReqId}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    expect((overlapCast(await read.json())).status).toBe("expired");

    // Asking for only the pending rows must not return it, which is the part
    // a projection-on-read cannot deliver.
    const pending = await app.request(
      "/v1/authorization-requests?status=pending",
      { headers: { authorization: `Bearer ${approver.accessToken}` } },
    );
    const { requests } = overlapCast(await pending.json());
    expect(requests.map((r) => r.authReqId)).not.toContain(authReqId);
  });

  it("chaos: two approvers racing get a conflict, never a 500", async () => {
    // Both handlers read the row before either writes, so the second write
    // loses the version check. That is a conflict the caller can act on — a
    // 500 would read as "the decision may or may not have landed".
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver),
    );
    const { authReqId, requestDigest } = overlapCast(await created.json());

    const [first, second] = await Promise.all([
      decide(app, approver.accessToken, authReqId, "approve", requestDigest),
      decide(app, approver.accessToken, authReqId, "approve", requestDigest),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(200);
    // 409 is the repository's version conflict reaching the caller as a
    // conflict; before this it escaped the handler and became a 500.
    expect(statuses[1]).toBe(409);
  });

  it("adversarial: the requester reference is opaque, never the caller's principal id", async () => {
    // This value reaches inboxes and, once relay lands, public bus subjects.
    const app = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver),
    );
    const raw = await created.text();
    expect(raw).not.toContain(requester.principalId);
  });
});
