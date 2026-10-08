import { randomUUID } from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import { createControlPlane } from "../create-app.js";
import { assertionFor, enrolPasskey } from "./interaction-webauthn-fixture.js";

type Actor = { principalId: string; accessToken: string };
type Pending = { authReqId: string; requestDigest: string; status: string };
export type Plane = ReturnType<typeof createControlPlane>;
export const headers = (who: Actor) => ({
  authorization: `Bearer ${who.accessToken}`,
  "content-type": "application/json",
});
export async function actor(cp: Plane): Promise<Actor> {
  const response = await cp.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(response.status).toBe(201);
  return overlapCast(await response.json());
}
export async function signedApprovalFixture() {
  let now = Date.now();
  const cp = createControlPlane({
    processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
    // Select the real SimpleWebAuthn verifier, not the development length verdict.
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      allowDevDefaults: false,
    },
    clock: () => new Date(now),
  });
  const approver = await actor(cp);
  const requester = await actor(cp);
  const key = await enrolPasskey(cp, approver.principalId);
  const inbox = await cp.app.request("/v1/authorization-requests/inbox-ref", {
    headers: headers(approver),
  });
  expect(inbox.status).toBe(200);
  const address: { approverRef: string } = overlapCast(await inbox.json());
  const asked = await cp.app.request("/v1/authorization-requests", {
    method: "POST",
    headers: { ...headers(requester), "idempotency-key": randomUUID() },
    body: JSON.stringify({
      approverRef: address.approverRef,
      bindingMessage: "Write to repository",
      ttlSeconds: 3600,
      authorizationDetails: [
        {
          type: "connection_delegation",
          actions: ["repository.write"],
          locations: ["repo:outcomes/catalog"],
        },
      ],
    }),
  });
  expect(asked.status).toBe(201);
  const request: Pending = overlapCast(await asked.json());
  const requirement = await cp.app.request(
    `/v1/authorization-requests/${request.authReqId}/requirement`,
    {
      headers: headers(approver),
    },
  );
  expect(requirement.status).toBe(200);
  expect(await requirement.json()).toMatchObject({
    riskClass: "moderate",
    requireTransactionBoundActivation: true,
  });
  return {
    cp,
    approver,
    requester,
    key,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof signedApprovalFixture>>;
export async function begin(f: Fixture) {
  const response = await f.cp.app.request(
    `/v1/authorization-requests/${f.request.authReqId}/activation`,
    {
      method: "POST",
      headers: headers(f.approver),
      body: JSON.stringify({
        decision: "approved",
        requestDigest: f.request.requestDigest,
      }),
    },
  );
  expect(response.status).toBe(201);
  const body: { activationId: string; options: { challenge: string } } =
    overlapCast(await response.json());
  expect(body.options.challenge).not.toBe("");
  return { id: body.activationId, challenge: body.options.challenge };
}
export function complete(f: Fixture, id: string, assertion: JsonObject) {
  return f.cp.app.request(
    `/v1/authorization-requests/${f.request.authReqId}/activation/complete`,
    {
      method: "POST",
      headers: headers(f.approver),
      body: JSON.stringify({ activationId: id, ...assertion }),
    },
  );
}
export function approve(f: Fixture, id: string) {
  return f.cp.app.request(
    `/v1/authorization-requests/${f.request.authReqId}/approve`,
    {
      method: "POST",
      headers: headers(f.approver),
      body: JSON.stringify({
        requestDigest: f.request.requestDigest,
        activationId: id,
      }),
    },
  );
}
export async function proveFresh(f: Fixture) {
  const activation = await begin(f);
  const response = await complete(
    f,
    activation.id,
    assertionFor(activation.challenge, f.key),
  );
  expect(response.status).toBe(200);
  return activation;
}
export async function unapproved(f: Fixture) {
  expect(
    (await f.cp.ctx.repos.authorizationRequests.getById(f.request.authReqId))
      ?.status,
  ).toBe("pending");
  expect(
    await f.cp.ctx.repos.approvalReceipts.getForRequest(f.request.authReqId),
  ).toBeNull();
  expect(
    (await f.cp.ctx.repos.outbox.listUnpublished()).filter(
      (row) => row.eventType === "authority.invocation.completed",
    ),
  ).toEqual([]);
}
