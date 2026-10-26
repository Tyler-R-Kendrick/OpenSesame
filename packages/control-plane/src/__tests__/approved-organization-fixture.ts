import type { Organization } from "@opensesame/os-domain";
import { expect } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import type { AppContext } from "../context.js";
import type { createControlPlane } from "../create-app.js";

/** Explicit operator approval, scoped to the exact existing tenant. */
export function approveOrganizationIssuers(
  ctx: AppContext,
  id: string,
  ...issuers: string[]
) {
  ctx.config.organizationIssuerAllowlist = [
    ...(ctx.config.organizationIssuerAllowlist ?? []),
    ...issuers.map((issuer) => `${id}|${issuer}`),
  ];
}

/** Simulate the deployment operator approving a tenant's federation claim. */
export async function seedApprovedOrganization(
  ctx: AppContext,
  org: Omit<Organization, "createdAt" | "updatedAt">,
) {
  ctx.config.organizationIssuerAllowlist = [
    ...(ctx.config.organizationIssuerAllowlist ?? []),
    ...[org.ssoIssuer, org.samlIssuer]
      .filter((issuer): issuer is string => Boolean(issuer))
      .map((issuer) => `${org.id}|${issuer}`),
  ];
  const now = ctx.clock();
  await ctx.stores.organizations.set(org.id, {
    ...org,
    createdAt: now,
    updatedAt: now,
  });
}

/** Configure federation through the API only after operator approval. */
export async function configureApprovedOrganization(
  plane: Pick<ReturnType<typeof createControlPlane>, "ctx" | "app">,
  id: string,
  accessToken: string,
  ssoIssuer: string,
) {
  approveOrganizationIssuers(plane.ctx, id, ssoIssuer);
  return plane.app.request(`/v1/organizations/${id}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ssoIssuer }),
  });
}

export function approvedOrganizationIssuerPairs(
  organizations: readonly Organization[],
) {
  return organizations.flatMap((org) =>
    [org.ssoIssuer, org.samlIssuer]
      .filter(Boolean)
      .map((issuer) => `${org.id}|${issuer}`),
  );
}

/** Create the tenant first so approval can name its actual opaque ID. */
export async function createApprovedOrganization(
  plane: Pick<ReturnType<typeof createControlPlane>, "ctx" | "app">,
  accessToken: string,
  slug: string,
  displayName: string,
  issuer: string,
) {
  const created = await plane.app.request("/v1/organizations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ slug, displayName }),
  });
  expect(created.status).toBe(201);
  const org: { id: string } = await created.json();
  const configured = await configureApprovedOrganization(
    plane,
    org.id,
    accessToken,
    issuer,
  );
  expect(configured.status).toBe(200);
  return org;
}

export function approvedOrganizationConfig(
  config: ControlPlaneConfig,
  organizations: readonly Organization[],
) {
  return {
    ...config,
    organizationIssuerAllowlist: approvedOrganizationIssuerPairs(organizations),
  };
}
