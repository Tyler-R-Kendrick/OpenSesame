import {
  type JsonObject,
  type Organization,
  overlapCast,
} from "@opensesame/os-domain";
import { expect } from "vitest";
import type { createControlPlane } from "../create-app.js";
import type { OrganizationIssuerAssignment } from "../organization-issuer-assignments.js";

type Plane = ReturnType<typeof createControlPlane>;
type Context = Plane["ctx"];

/** Model an operator approving a specific tenant and its exact federation source. */
export function approveFederationFixture(
  ctx: Context,
  assignment: OrganizationIssuerAssignment,
) {
  const assignments = ctx.config.organizationIssuerAssignments;
  if (!assignments) throw new Error("organizationIssuerAssignments missing");
  const previous = assignments.findIndex(
    (entry) => entry.organizationId === assignment.organizationId,
  );
  if (previous >= 0) assignments.splice(previous, 1, assignment);
  else assignments.push(assignment);
}

/** Seed a known operator-approved organization, without approving request input. */
export async function setApprovedOrganizationFixture(
  ctx: Context,
  id: string,
  organization: Organization,
) {
  const { ssoIssuer, samlIssuer, samlMetadataUrl, samlMetadataXml } =
    organization;
  approveFederationFixture(ctx, {
    organizationId: id,
    ssoIssuer,
    samlIssuer,
    samlMetadataUrl,
    samlMetadataXml,
  });
  await ctx.stores.organizations.set(id, organization);
}

/** Create a plain fixture tenant, approve its fixed IdP, then configure it as owner. */
export async function createApprovedOrganizationFixture(
  app: Plane["app"],
  ctx: Context,
  init: RequestInit,
) {
  if (typeof init.body !== "string") throw new Error("fixture body missing");
  const { ssoIssuer, samlIssuer, samlMetadataUrl, samlMetadataXml, ...plain } =
    JSON.parse(init.body);
  const created = await app.request("/v1/organizations", {
    ...init,
    body: JSON.stringify(plain),
  });
  expect(created.status).toBe(201);
  const organization = await created.json();
  if (ssoIssuer || samlIssuer || samlMetadataUrl || samlMetadataXml) {
    approveFederationFixture(ctx, {
      organizationId: organization.id,
      ssoIssuer,
      samlIssuer,
      samlMetadataUrl,
      samlMetadataXml,
    });
    const configured = await app.request(
      `/v1/organizations/${encodeURIComponent(organization.id)}`,
      {
        method: "PATCH",
        ...(init.headers ? { headers: init.headers } : {}),
        body: JSON.stringify({
          ssoIssuer,
          samlIssuer,
          samlMetadataUrl,
          samlMetadataXml,
        }),
      },
    );
    expect(configured.status).toBe(200);
    return new Response(await configured.text(), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(organization), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

/** Standard active organization attributes shared by approved protocol fixtures. */
export async function seedApprovedOrganizationFixture(
  ctx: Context,
  organization: Pick<Organization, "id" | "slug" | "displayName"> &
    Partial<Organization>,
) {
  const now = ctx.clock();
  await setApprovedOrganizationFixture(ctx, organization.id, {
    state: "active",
    createdBy: "prn_seed_owner",
    createdAt: now,
    updatedAt: now,
    ...organization,
  });
}

/** Create and approve the fixed home-realm-discovery fixture over its HTTP API. */
export async function seedApprovedDomainOrganizationFixture(
  ctx: Context,
  request: (
    path: string,
    init?: RequestInit,
  ) => Promise<{ status: number; body: JsonObject }>,
  slug: string,
  ownerToken: string,
  issuer: string,
) {
  const headers = {
    authorization: `Bearer ${ownerToken}`,
    "content-type": "application/json",
  };
  const created = await request("/v1/organizations", {
    method: "POST",
    headers,
    body: JSON.stringify({ slug, displayName: `Org ${slug}` }),
  });
  expect(created.status).toBe(201);
  const id = String(created.body.id);
  const ssoIssuer = `${issuer}/${slug}`;
  approveFederationFixture(ctx, { organizationId: id, ssoIssuer });
  const configured = await request(
    `/v1/organizations/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ssoIssuer }),
    },
  );
  expect(configured.status).toBe(200);
  return { id, ownerToken };
}

/** Create a named protocol fixture using its already verified owner's session. */
export async function createApprovedTenantFixture(
  app: Plane["app"],
  ctx: Context,
  ownerToken: string,
  definition: Pick<
    Organization,
    "slug" | "displayName" | "ssoIssuer" | "samlIssuer"
  >,
) {
  const created = await createApprovedOrganizationFixture(app, ctx, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(definition),
  });
  return overlapCast(await created.json());
}
