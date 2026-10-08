import { randomUUID } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type Plane = ReturnType<typeof createControlPlane>;
type Actor = { principalId: string; accessToken: string };
type Pending = { authReqId: string; requestDigest: string; status: string };

async function actor(plane: Plane): Promise<Actor> {
  const response = await plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(response.status).toBe(201);
  return overlapCast(await response.json());
}
const headers = (who: Actor) => ({
  authorization: `Bearer ${who.accessToken}`,
});
async function inbox(plane: Plane, approver: Actor) {
  const response = await plane.app.request(
    "/v1/authorization-requests/inbox-ref",
    {
      headers: headers(approver),
    },
  );
  expect(response.status).toBe(200);
  const body: { approverRef: string } = overlapCast(await response.json());
  return body.approverRef;
}
function ask(
  plane: Plane,
  requester: Actor,
  approverRef: string,
  message: string,
) {
  return plane.app.request("/v1/authorization-requests", {
    method: "POST",
    headers: {
      ...headers(requester),
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({
      approverRef,
      bindingMessage: message,
      authorizationDetails: [
        {
          type: "connection_delegation",
          actions: ["repository.read"],
          locations: ["repo:acme/catalog"],
        },
      ],
    }),
  });
}
function deployment() {
  return createControlPlane({
    processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  });
}

it.each(["suspended", "closed"] as const)(
  "refuses a previously issued inbox handle after the approver becomes %s without publishing a prompt",
  async (state) => {
    const plane = deployment();
    const approver = await actor(plane);
    const requester = await actor(plane);
    const ref = await inbox(plane, approver);
    const positive = await ask(plane, requester, ref, "Before revocation");
    expect(positive.status).toBe(201);
    const principal = await plane.ctx.repos.principals.getById(
      approver.principalId,
    );
    if (!principal) throw new Error("fixture principal missing");
    // Genuine durable administrative state, not a replaced authorization verdict.
    await plane.ctx.repos.principals.update(
      principal.id,
      { state },
      principal.version,
    );
    const rows = await plane.ctx.repos.authorizationRequests.listForPrincipal(
      principal.id,
    );
    const outbox = await plane.ctx.repos.outbox.listUnpublished();
    const refused = await ask(plane, requester, ref, "After revocation");
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "not_found" });
    expect(
      await plane.ctx.repos.authorizationRequests.listForPrincipal(
        principal.id,
      ),
    ).toEqual(rows);
    expect(await plane.ctx.repos.outbox.listUnpublished()).toEqual(outbox);
  },
);

it("filters durable inbox decisions without exposing another principal's requests", async () => {
  const plane = deployment();
  const approver = await actor(plane);
  const requester = await actor(plane);
  const stranger = await actor(plane);
  const ref = await inbox(plane, approver);
  const first = await ask(plane, requester, ref, "Deny this operation");
  const second = await ask(
    plane,
    requester,
    ref,
    "Leave this operation pending",
  );
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const denied: Pending = overlapCast(await first.json());
  const pending: Pending = overlapCast(await second.json());
  const decision = await plane.app.request(
    `/v1/authorization-requests/${denied.authReqId}/deny`,
    {
      method: "POST",
      headers: { ...headers(approver), "content-type": "application/json" },
      body: JSON.stringify({ requestDigest: denied.requestDigest }),
    },
  );
  expect(decision.status).toBe(200);
  expect(await decision.json()).toMatchObject({
    authReqId: denied.authReqId,
    status: "denied",
  });
  for (const [status, expected] of [
    ["denied", [denied.authReqId]],
    ["pending", [pending.authReqId]],
    ["approved", []],
    ["cancelled", []],
  ] as const) {
    const response = await plane.app.request(
      `/v1/authorization-requests?status=${status}`,
      {
        headers: headers(approver),
      },
    );
    expect(response.status).toBe(200);
    const body: { requests: Pending[] } = overlapCast(await response.json());
    expect(body.requests.map((row) => row.authReqId)).toEqual(expected);
  }
  const all = await plane.app.request(
    "/v1/authorization-requests?status=invalid",
    {
      headers: headers(approver),
    },
  );
  expect(all.status).toBe(200);
  const listed: { requests: Pending[] } = overlapCast(await all.json());
  expect(listed.requests.map((row) => row.authReqId).sort()).toEqual(
    [denied.authReqId, pending.authReqId].sort(),
  );
  const foreign = await plane.app.request(
    "/v1/authorization-requests?status=denied",
    {
      headers: headers(stranger),
    },
  );
  expect(foreign.status).toBe(200);
  expect(await foreign.json()).toEqual({ requests: [] });
});
