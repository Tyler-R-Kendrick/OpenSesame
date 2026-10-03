import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import {
  FACTORY_DELEGATION,
  type FactoryPlane,
  factoryInboxRef,
  factoryPlane,
  factoryPrincipal,
  factoryRaise,
} from "./interaction-factory-helpers.js";

/**
 * Who may be asked, and how a requester takes a question back (ADR 0159).
 *
 * The approver library of `crates/agent-hooks` raises an authorization request
 * and fronts it with an interaction. These tests hold the Identity API to the
 * three things that library relies on: a person cannot be asked by their own
 * principal or on behalf of somebody else's request, a refusal is
 * distinguishable from silence, and a requester can withdraw what it raised.
 */

type Who = { accessToken: string; principalId: string };

let seq = 0;

function json(token: string, body?: JsonObject): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": `guard-${++seq}`,
    },
    ...(body ? { body: JSON.stringify(body) } : undefined),
  };
}

/** An authorization request raised through the real route. */
async function raiseAuthorizationRequest(
  cp: FactoryPlane,
  requester: Who,
  approverRef: string,
) {
  const res = await cp.app.request(
    "/v1/authorization-requests",
    json(requester.accessToken, {
      approverRef,
      authorizationDetails: [FACTORY_DELEGATION],
      bindingMessage: "Read acme/catalog",
      ttlSeconds: 300,
    }),
  );
  expect(res.status).toBe(201);
  return overlapCast<{ authReqId: string; requestDigest: string }>(
    await res.json(),
  );
}

async function cancel(cp: FactoryPlane, who: Who, authReqId: string) {
  return cp.app.request(
    `/v1/authorization-requests/${authReqId}/cancel`,
    json(who.accessToken),
  );
}

async function detailAs(cp: FactoryPlane, who: Who, ref: string) {
  const res = await cp.app.request(`/v1/interactions/${ref}`, {
    headers: { authorization: `Bearer ${who.accessToken}` },
  });
  return {
    status: res.status,
    body: overlapCast<JsonObject>(await res.json()),
  };
}

describe("who an interaction may ask (requester != approver)", () => {
  let cp: FactoryPlane;
  beforeEach(() => {
    cp = factoryPlane();
  });

  it("adversarial: a requester whose bearer is the approver's own principal cannot front a request", async () => {
    const owner = await factoryPrincipal(cp);
    const ownInbox = await factoryInboxRef(cp, owner.accessToken);
    // The agent runs as its owner: the request is addressed to the owner and
    // raised by the owner's own bearer.
    const request = await raiseAuthorizationRequest(cp, owner, ownInbox);

    const res = await factoryRaise(
      cp,
      owner,
      ownInbox,
      "authorization_request",
      request.authReqId,
    );
    // The same 404 as an unverifiable handle: nothing here confirms anything.
    expect(res.status).toBe(404);
    expect(overlapCast<JsonObject>(await res.json()).error).toBe(
      "interaction_not_found",
    );
  });

  it("adversarial: the addressee of a request cannot front it either", async () => {
    const requester = await factoryPrincipal(cp);
    const approver = await factoryPrincipal(cp);
    const approverInbox = await factoryInboxRef(cp, approver.accessToken);
    const request = await raiseAuthorizationRequest(
      cp,
      requester,
      approverInbox,
    );

    const res = await factoryRaise(
      cp,
      approver,
      approverInbox,
      "authorization_request",
      request.authReqId,
    );
    expect(res.status).toBe(404);
  });

  it("adversarial: a request cannot be fronted by asking somebody other than its addressee", async () => {
    const requester = await factoryPrincipal(cp);
    const addressee = await factoryPrincipal(cp);
    const bystander = await factoryPrincipal(cp);
    const request = await raiseAuthorizationRequest(
      cp,
      requester,
      await factoryInboxRef(cp, addressee.accessToken),
    );

    // B's "yes" would settle A's request.
    const substituted = await factoryRaise(
      cp,
      requester,
      await factoryInboxRef(cp, bystander.accessToken),
      "authorization_request",
      request.authReqId,
    );
    expect(substituted.status).toBe(404);

    const honest = await factoryRaise(
      cp,
      requester,
      await factoryInboxRef(cp, addressee.accessToken),
      "authorization_request",
      request.authReqId,
    );
    expect(honest.status).toBe(201);
  });

  it("contract: a person's own device ceremony is still theirs to approve", async () => {
    // Device, pairing, claim and transaction ceremonies are owned by the
    // caller and routinely approved by the same person on a second device, so
    // the guard is scoped to the kind that means "somebody else looks".
    const owner = await factoryPrincipal(cp);
    const res = await factoryRaise(
      cp,
      owner,
      await factoryInboxRef(cp, owner.accessToken),
      "device_authorization",
      "dev-guard-1",
    );
    expect(res.status).toBe(201);
  });
});

describe("a requester withdraws an authorization request", () => {
  let cp: FactoryPlane;
  let requester: Who;
  let approver: Who;
  let approverInbox: string;
  beforeEach(async () => {
    cp = factoryPlane();
    requester = await factoryPrincipal(cp);
    approver = await factoryPrincipal(cp);
    approverInbox = await factoryInboxRef(cp, approver.accessToken);
  });

  it("contract: cancelling closes the request and the interaction fronting it", async () => {
    const request = await raiseAuthorizationRequest(
      cp,
      requester,
      approverInbox,
    );
    const fronted = await factoryRaise(
      cp,
      requester,
      approverInbox,
      "authorization_request",
      request.authReqId,
    );
    expect(fronted.status).toBe(201);
    const { ref } = overlapCast<{ ref: string }>(await fronted.json());

    const res = await cancel(cp, requester, request.authReqId);
    expect(res.status).toBe(200);
    const body = overlapCast<JsonObject>(await res.json());
    expect(body.status).toBe("cancelled");
    expect(body.authReqId).toBe(request.authReqId);
    expect(body.decidedAt).toBeTypeOf("string");
    // A withdrawal is not a decision: nobody is named as having decided it.
    expect(body.decidedByKind).toBeUndefined();

    // Gone from the approver's inbox of pending questions.
    const inbox = await cp.app.request(
      "/v1/authorization-requests?status=pending",
      { headers: { authorization: `Bearer ${approver.accessToken}` } },
    );
    expect(
      overlapCast<{ requests: JsonObject[] }>(await inbox.json()).requests,
    ).toEqual([]);

    // And the interaction cannot be approved or spent afterwards.
    expect((await detailAs(cp, approver, ref)).body.status).toBe("revoked");
    const spent = await cp.app.request(
      `/v1/interactions/${ref}/consume`,
      json(requester.accessToken),
    );
    expect(spent.status).toBe(409);
    expect(overlapCast<JsonObject>(await spent.json()).error).toBe(
      "interaction_revoked",
    );
  });

  it("contract: cancelling twice answers the same state and changes nothing", async () => {
    const request = await raiseAuthorizationRequest(
      cp,
      requester,
      approverInbox,
    );
    const first = await cancel(cp, requester, request.authReqId);
    const second = await cancel(cp, requester, request.authReqId);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(overlapCast<JsonObject>(await second.json()).status).toBe(
      "cancelled",
    );
  });

  it("adversarial: only the requester may withdraw, and everyone else gets the same 404", async () => {
    const request = await raiseAuthorizationRequest(
      cp,
      requester,
      approverInbox,
    );
    const stranger = await factoryPrincipal(cp);
    const forApprover = await cancel(cp, approver, request.authReqId);
    const forStranger = await cancel(cp, stranger, request.authReqId);
    const unknown = await cancel(cp, requester, "areq_does_not_exist");
    for (const res of [forApprover, forStranger, unknown]) {
      expect(res.status).toBe(404);
      expect(overlapCast<JsonObject>(await res.json())).toEqual({
        error: "not_found",
      });
    }
    // Nothing moved.
    const read = await cp.app.request(
      `/v1/authorization-requests/${request.authReqId}`,
      { headers: { authorization: `Bearer ${requester.accessToken}` } },
    );
    expect(overlapCast<JsonObject>(await read.json()).status).toBe("pending");
  });

  it("adversarial: an answered request keeps its ending", async () => {
    const request = await raiseAuthorizationRequest(
      cp,
      requester,
      approverInbox,
    );
    const row = await cp.ctx.repos.authorizationRequests.getById(
      request.authReqId,
    );
    expect(row).not.toBeNull();
    await cp.ctx.repos.authorizationRequests.updateWithVersion(
      request.authReqId,
      row?.version ?? 0,
      { status: "denied", decidedAt: cp.ctx.clock() },
    );
    const res = await cancel(cp, requester, request.authReqId);
    expect(res.status).toBe(409);
    expect(overlapCast<JsonObject>(await res.json())).toEqual({
      error: "request_not_pending",
      status: "denied",
    });
  });

  it("adversarial: a lapsed request reports that it lapsed", async () => {
    let nowMs = Date.parse("2026-09-28T12:00:00.000Z");
    resetInteractionLinkBudget();
    const timed = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
      clock: () => new Date(nowMs),
    });
    const a = await factoryPrincipal(timed);
    const b = await factoryPrincipal(timed);
    const request = await raiseAuthorizationRequest(
      timed,
      a,
      await factoryInboxRef(timed, b.accessToken),
    );
    nowMs += 301_000;
    const res = await cancel(timed, a, request.authReqId);
    expect(res.status).toBe(410);
    expect(overlapCast<JsonObject>(await res.json()).error).toBe(
      "expired_request",
    );
  });

  it("contract: the withdrawal is audited by digest, never by content", async () => {
    const request = await raiseAuthorizationRequest(
      cp,
      requester,
      approverInbox,
    );
    await cancel(cp, requester, request.authReqId);
    const events = await cp.ctx.repos.auditEvents.list({
      principalId: requester.principalId,
    });
    const cancelled = events.find(
      (event) => event.eventType === "authority.invocation.cancelled",
    );
    expect(cancelled?.outcome).toBe("succeeded");
    expect(cancelled?.metadata).toEqual({
      authReqId: request.authReqId,
      requestDigest: request.requestDigest,
    });
  });
});

describe("a refusal is not silence", () => {
  it("contract: consuming a denied interaction is 403 approval_denied, a waiting one 401", async () => {
    const cp = factoryPlane();
    const requester = await factoryPrincipal(cp);
    const approver = await factoryPrincipal(cp);
    const inbox = await factoryInboxRef(cp, approver.accessToken);
    const request = await raiseAuthorizationRequest(cp, requester, inbox);
    const fronted = await factoryRaise(
      cp,
      requester,
      inbox,
      "authorization_request",
      request.authReqId,
    );
    const { ref, requestDigest } = overlapCast<{
      ref: string;
      requestDigest: string;
    }>(await fronted.json());

    const waiting = await cp.app.request(
      `/v1/interactions/${ref}/consume`,
      json(requester.accessToken),
    );
    expect(waiting.status).toBe(401);
    expect(overlapCast<JsonObject>(await waiting.json()).error).toBe(
      "approval_required",
    );

    const denied = await cp.app.request(
      `/v1/interactions/${ref}/deny`,
      json(approver.accessToken, { requestDigest }),
    );
    expect(denied.status).toBe(200);

    const refused = await cp.app.request(
      `/v1/interactions/${ref}/consume`,
      json(requester.accessToken),
    );
    expect(refused.status).toBe(403);
    expect(overlapCast<JsonObject>(await refused.json())).toEqual({
      error: "approval_denied",
    });
    // Nobody else can use the route to learn it.
    const stranger = await factoryPrincipal(cp);
    const probe = await cp.app.request(
      `/v1/interactions/${ref}/consume`,
      json(stranger.accessToken),
    );
    expect(probe.status).toBe(404);
  });
});
