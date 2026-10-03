import {
  type Interaction,
  type JsonObject,
  bindingMessageDigest,
  canonicalRequestDigest,
  deriveBindingMessage,
  mintInteractionRef,
  overlapCast,
} from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { requesterRef } from "../routes/interaction-handles.js";
import {
  FACTORY_DELEGATION,
  type FactoryPlane,
  factoryInboxRef,
  factoryPlane,
  factoryPrincipal,
  factoryWebauthnApprove,
} from "./interaction-factory-helpers.js";

/**
 * What a person approves is what the request carries (ADR 0086, ADR 0159).
 *
 * An interaction's digest is computed over the details its create call
 * carried, and the approver's WebAuthn activation is bound to that digest.
 * Nothing used to compare those details with the authorization request being
 * fronted, so a requester could raise a request for X, front it with an
 * interaction showing a benign Y, and settle X on the strength of an approval
 * of Y.
 */

type Who = { accessToken: string; principalId: string };

const BENIGN: JsonObject = {
  type: "connection_delegation",
  actions: ["repository.read"],
  locations: ["repo:acme/public-docs"],
};

let seq = 0;

function post(token: string, body?: JsonObject): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": `binding-${++seq}`,
    },
    ...(body ? { body: JSON.stringify(body) } : undefined),
  };
}

async function raiseRequest(cp: FactoryPlane, who: Who, approverRef: string) {
  const res = await cp.app.request(
    "/v1/authorization-requests",
    post(who.accessToken, {
      approverRef,
      authorizationDetails: [FACTORY_DELEGATION],
      bindingMessage: "Read acme/catalog",
      ttlSeconds: 300,
    }),
  );
  expect(res.status).toBe(201);
  return overlapCast<{ authReqId: string }>(await res.json()).authReqId;
}

function front(
  cp: FactoryPlane,
  who: Who,
  approverRef: string,
  subjectId: string,
  details: JsonObject[],
) {
  return cp.app.request(
    "/v1/interactions",
    post(who.accessToken, {
      kind: "authorization_request",
      subject: { kind: "authorization_request", subjectId },
      approverRef,
      authorizationDetails: details,
      ttlSeconds: 300,
    }),
  );
}

describe("an interaction fronting an authorization request", () => {
  let cp: FactoryPlane;
  let requester: Who;
  let approver: Who;
  let approverRef: string;
  beforeEach(async () => {
    cp = factoryPlane();
    requester = await factoryPrincipal(cp);
    approver = await factoryPrincipal(cp);
    approverRef = await factoryInboxRef(cp, approver.accessToken);
  });

  it("adversarial: refuses details that are not the request's own", async () => {
    const authReqId = await raiseRequest(cp, requester, approverRef);

    const swapped = await front(cp, requester, approverRef, authReqId, [
      BENIGN,
    ]);
    expect(swapped.status).toBe(404);
    expect(overlapCast<JsonObject>(await swapped.json()).error).toBe(
      "interaction_not_found",
    );

    // Adding a detail is as much a mismatch as swapping one.
    const widened = await front(cp, requester, approverRef, authReqId, [
      FACTORY_DELEGATION,
      BENIGN,
    ]);
    expect(widened.status).toBe(404);

    // A changed member inside an otherwise identical detail is a mismatch too.
    const narrowed = await front(cp, requester, approverRef, authReqId, [
      { ...FACTORY_DELEGATION, actions: ["repository.write"] },
    ]);
    expect(narrowed.status).toBe(404);
  });

  it("contract: the request's own details, in any member order, are accepted", async () => {
    const authReqId = await raiseRequest(cp, requester, approverRef);
    const reordered: JsonObject = {
      locations: FACTORY_DELEGATION.locations,
      actions: FACTORY_DELEGATION.actions,
      type: FACTORY_DELEGATION.type,
    };
    const res = await front(cp, requester, approverRef, authReqId, [reordered]);
    expect(res.status).toBe(201);
  });

  it("adversarial: a forged interaction cannot settle a request it does not describe", async () => {
    const authReqId = await raiseRequest(cp, requester, approverRef);
    // Written straight to the store, past the create route's check: the
    // settlement itself must still refuse.
    const pepper = cp.ctx.config.claimPepper;
    const minted = mintInteractionRef(pepper);
    const now = cp.ctx.clock();
    const expiresAt = new Date(now.getTime() + 300_000);
    const requesterHandle = requesterRef(requester.principalId, pepper);
    const details = [overlapCast<typeof BENIGN, never>(BENIGN)];
    const bindingMessage = deriveBindingMessage(details);
    const digest = canonicalRequestDigest({
      kind: "authorization_request",
      subject: `authorization_request:${authReqId}`,
      approverRef,
      requesterRef: requesterHandle,
      authorizationDetails: details,
      bindingMessage,
      expiresAt: expiresAt.toISOString(),
    });
    const forged: Interaction = {
      id: minted.id,
      kind: "authorization_request",
      status: "pending",
      subject: { kind: "authorization_request", subjectId: authReqId },
      createdAt: now,
      expiresAt,
      requesterRef: requesterHandle,
      approverPrincipalId: approver.principalId,
      requestDigest: digest,
      bindingMessageDigest: bindingMessageDigest(bindingMessage, pepper),
      bindingMessage,
      authorizationDetails: details,
      version: 1,
    };
    await cp.ctx.repos.interactions.create(forged);

    const approved = await factoryWebauthnApprove(
      cp,
      approver,
      minted.ref,
      digest,
    );
    expect(approved.status).toBe(200);

    const consumed = await cp.app.request(
      `/v1/interactions/${minted.ref}/consume`,
      post(requester.accessToken),
    );
    expect(consumed.status).toBeGreaterThanOrEqual(400);
    const row = await cp.ctx.repos.authorizationRequests.getById(authReqId);
    expect(row?.status).toBe("pending");
    expect(row?.decidedByPrincipalId).toBeUndefined();
  });
});
