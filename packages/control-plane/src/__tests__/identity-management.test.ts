import { expect, it } from "vitest";
import { z } from "zod";
import { createControlPlane } from "../create-app.js";

const Actor = z.object({ principalId: z.string(), accessToken: z.string() });
const Id = z.object({ id: z.string() });
type AgentPatchCase =
  | { displayName: string }
  | { state: "revoked" | "claimed" }
  | { ownerPrincipalId: string };
async function actor(plane: ReturnType<typeof createControlPlane>) {
  const response = await plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(response.status).toBe(201);
  const result = Actor.parse(await response.json());
  const principal = await plane.ctx.repos.principals.getById(
    result.principalId,
  );
  if (!principal) throw new Error("Missing fixture principal");
  await plane.ctx.repos.principals.update(
    principal.id,
    { state: "active", assurance: "verified", verifiedAt: plane.ctx.clock() },
    principal.version,
  );
  return result;
}
function headers(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

it("lets only the organization owner create and manage directory users with their session", async () => {
  const plane = createControlPlane();
  const owner = await actor(plane);
  const other = await actor(plane);
  const created = await plane.app.request("/v1/organizations", {
    method: "POST",
    headers: headers(owner.accessToken),
    body: JSON.stringify({
      slug: "managed-users",
      displayName: "Managed users",
    }),
  });
  expect(created.status).toBe(201);
  const org = Id.parse(await created.json());
  const path = `/v1/organizations/${org.id}/scim/v2/Users`;
  const input = JSON.stringify({
    userName: "alice",
    displayName: "Alice",
    active: true,
  });
  expect(
    (
      await plane.app.request(path, {
        method: "POST",
        headers: headers(other.accessToken),
        body: input,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await plane.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: input,
      })
    ).status,
  ).toBe(401);
  const user = await plane.app.request(path, {
    method: "POST",
    headers: headers(owner.accessToken),
    body: input,
  });
  expect(user.status).toBe(201);
  const { id } = Id.parse(await user.json());
  // Provisioning never fabricates an authenticated principal.
  expect(await plane.ctx.repos.principals.getById(id)).toBeNull();
  const listed = await plane.app.request(path, {
    headers: headers(owner.accessToken),
  });
  expect(await listed.json()).toMatchObject({
    Resources: [{ id, userName: "alice", active: true }],
  });
  const edited = await plane.app.request(`${path}/${id}`, {
    method: "PATCH",
    headers: headers(owner.accessToken),
    body: JSON.stringify({
      Operations: [
        {
          op: "replace",
          value: { displayName: "Alice updated", active: false },
        },
      ],
    }),
  });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({
    displayName: "Alice updated",
    active: false,
  });
  await plane.ctx.stores.organizationMemberships.upsert({
    organizationId: org.id,
    principalId: owner.principalId,
    role: "member",
    createdAt: plane.ctx.clock(),
    updatedAt: plane.ctx.clock(),
  });
  expect(
    (await plane.app.request(path, { headers: headers(owner.accessToken) }))
      .status,
  ).toBe(403);
});

it("lists only owned agents and makes revocation final under concurrent updates", async () => {
  const plane = createControlPlane();
  const owner = await actor(plane);
  const other = await actor(plane);
  const response = await plane.app.request("/v1/agents", {
    method: "POST",
    headers: headers(owner.accessToken),
    body: JSON.stringify({
      displayName: "Release agent",
      publicKeyJkt: "a".repeat(43),
    }),
  });
  expect(response.status).toBe(201);
  const { agentId } = z
    .object({ agentId: z.string() })
    .parse(await response.json());
  expect(
    await (
      await plane.app.request("/v1/agents", {
        headers: headers(other.accessToken),
      })
    ).json(),
  ).toEqual({ agents: [] });
  const listed = await plane.app.request("/v1/agents", {
    headers: headers(owner.accessToken),
  });
  expect(await listed.json()).toMatchObject({
    agents: [{ id: agentId, displayName: "Release agent" }],
  });
  const patch = (token: string, body: AgentPatchCase) =>
    plane.app.request(`/v1/agents/${agentId}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify(body),
    });
  expect((await patch(other.accessToken, { state: "revoked" })).status).toBe(
    404,
  );
  expect(
    (await patch(owner.accessToken, { ownerPrincipalId: other.principalId }))
      .status,
  ).toBe(400);
  expect(
    (await patch(owner.accessToken, { displayName: "Renamed agent" })).status,
  ).toBe(200);
  const races = await Promise.all([
    patch(owner.accessToken, { state: "revoked" }),
    patch(owner.accessToken, { state: "revoked" }),
  ]);
  expect(races.map((entry) => entry.status).sort()).toEqual([200, 409]);
  expect((await patch(owner.accessToken, { state: "claimed" })).status).toBe(
    400,
  );
  expect(
    (
      await plane.app.request(`/v1/agents/${agentId}/claim`, {
        method: "POST",
        headers: headers(owner.accessToken),
      })
    ).status,
  ).toBe(409);
  expect((await plane.ctx.stores.agents.get(agentId))?.state).toBe("revoked");
});
