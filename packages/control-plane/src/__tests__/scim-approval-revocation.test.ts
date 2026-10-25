import { createHash } from "node:crypto";
import type { Organization } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE } from "../routes/scim-effects.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";

type CreatedScimUser = {
  id: string;
  [SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE]?: string[];
};

it.each(["PATCH", "DELETE"])(
  "SCIM %s still removes existing membership and sessions after issuer approval is withdrawn",
  async (method) => {
    const { app, ctx } = createControlPlane();
    const minted = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const session: { principalId: string; accessToken: string } =
      await minted.json();
    const issuer = "https://historical-idp.example";
    const subject = "existing-member";
    const now = ctx.clock();
    const org: Organization = {
      id: "org:historical",
      slug: "historical",
      displayName: "Historical",
      state: "active",
      createdBy: session.principalId,
      createdAt: now,
      updatedAt: now,
      ssoIssuer: issuer,
      provisioningEnabled: true,
    };
    ctx.config.organizationIssuerAllowlist = [`${org.id}|${issuer}`];
    await ctx.stores.organizations.set(org.id, org);
    await ctx.stores.organizationMemberships.upsert({
      organizationId: org.id,
      principalId: session.principalId,
      role: "member",
      createdAt: now,
      updatedAt: now,
    });
    expect(
      (
        await attachVerifiedExternalIdentity(ctx, session.principalId, {
          kind: "oidc",
          issuer,
          subject,
          correlationId: "historical-member",
        })
      ).ok,
    ).toBe(true);
    const user = await ctx.stores.scim.users.create({
      id: "historical-user",
      organizationId: org.id,
      userName: subject,
      externalId: subject,
      active: true,
      raw: {},
      createdAt: now,
      updatedAt: now,
    });
    const token = "sct_historical-test-token";
    await ctx.stores.scim.tokens.mint(
      org.id,
      createHash("sha256").update(token).digest("hex"),
    );
    ctx.config.organizationIssuerAllowlist = [];

    const request: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    };
    if (method === "PATCH") {
      request.body = JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      });
    }
    const response = await app.request(
      `/v1/organizations/${org.id}/scim/v2/Users/${user.id}`,
      request,
    );
    expect(response.status).toBe(method === "PATCH" ? 200 : 204);
    expect(
      await ctx.stores.organizationMemberships.find(
        org.id,
        session.principalId,
      ),
    ).toBeUndefined();
    expect(
      (
        await app.request("/v1/organizations", {
          headers: { authorization: `Bearer ${session.accessToken}` },
        })
      ).status,
    ).toBe(401);
  },
);

it("ignores directory-supplied internal deprovision targets outside the tenant", async () => {
  const { app, ctx } = createControlPlane();
  const minted = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const outsider: { principalId: string; accessToken: string } =
    await minted.json();
  const now = ctx.clock();
  const org: Organization = {
    id: "org:marker",
    slug: "marker",
    displayName: "Marker",
    state: "active",
    createdBy: outsider.principalId,
    createdAt: now,
    updatedAt: now,
    provisioningEnabled: true,
  };
  await ctx.stores.organizations.set(org.id, org);
  const token = "sct_marker-test-token";
  await ctx.stores.scim.tokens.mint(
    org.id,
    createHash("sha256").update(token).digest("hex"),
  );
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const base = `/v1/organizations/${org.id}/scim/v2/Users`;
  const created = await app.request(base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      userName: "unrelated-directory-subject",
      "urn:opensesame:params:scim:2.0:deprovision-principals": [
        outsider.principalId,
      ],
    }),
  });
  expect(created.status).toBe(201);
  const raw: CreatedScimUser = await created.json();
  expect(
    raw["urn:opensesame:params:scim:2.0:deprovision-principals"],
  ).toBeUndefined();
  const user = raw;
  expect(
    (await app.request(`${base}/${user.id}`, { method: "DELETE", headers }))
      .status,
  ).toBe(204);
  // The directory has no member identity to offboard and cannot choose a target.
  expect(
    (
      await app.request("/v1/organizations", {
        headers: { authorization: `Bearer ${outsider.accessToken}` },
      })
    ).status,
  ).toBe(200);
});
