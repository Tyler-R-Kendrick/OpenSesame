import { overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resolveTrustedIssuer } from "../interactions/trust.js";

it("tenant issuer approval is default-deny, operator-controlled, and revocable for legacy rows", async () => {
  const { app, ctx } = createControlPlane();
  const session = overlapCast(
    await (
      await app.request("/v1/principals/provisional", { method: "POST" })
    ).json(),
  );
  const headers = {
    authorization: `Bearer ${session.accessToken}`,
    "content-type": "application/json",
  };
  const id = "org:approval";
  const issuer = "https://tenant-idp.example";
  const now = ctx.clock();
  const organization = {
    id,
    slug: "approval",
    displayName: "Approval",
    state: "active" as const,
    createdBy: session.principalId,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.stores.organizations.set(id, organization);
  await ctx.stores.organizationMemberships.upsert({
    organizationId: id,
    principalId: session.principalId,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  });
  const patch = () =>
    app.request(`/v1/organizations/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ssoIssuer: issuer }),
    });
  expect((await patch()).status).toBe(403);
  expect((await ctx.stores.organizations.get(id))?.ssoIssuer).toBeUndefined();
  ctx.config.organizationIssuerAllowlist = [`${id}|${issuer}/`];
  // Approval for this tenant cannot be used by another tenant, even its owner.
  const other = { ...organization, id: "org:other", slug: "other" };
  await ctx.stores.organizations.set(other.id, other);
  await ctx.stores.organizationMemberships.upsert({
    organizationId: other.id,
    principalId: session.principalId,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  });
  const stolen = await app.request(`/v1/organizations/${other.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ samlIssuer: issuer }),
  });
  expect(stolen.status).toBe(403);
  expect(
    (await ctx.stores.organizations.get(other.id))?.samlIssuer,
  ).toBeUndefined();
  expect((await patch()).status).toBe(200);
  expect(await resolveTrustedIssuer(ctx, issuer)).toMatchObject({
    source: "org",
    organizationId: id,
  });
  vi.spyOn(ctx.stores.organizations, "findByIssuer").mockReturnValueOnce(
    undefined,
  );
  expect(
    (
      await app.request("/v1/organizations/tenants/approval/join", {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "sso", idToken: "unused" }),
      })
    ).status,
  ).toBe(409);
  ctx.config.organizationIssuerAllowlist = [];
  expect(await resolveTrustedIssuer(ctx, issuer)).toBeUndefined();
  const join = await app.request("/v1/organizations/tenants/approval/join", {
    method: "POST",
    headers,
    body: JSON.stringify({ method: "sso", idToken: "unused" }),
  });
  expect(join.status).toBe(403);
  // Revoking operator approval never prevents clearing a stale tenant claim.
  expect(
    (
      await app.request(`/v1/organizations/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ ssoIssuer: null }),
      })
    ).status,
  ).toBe(200);
});
