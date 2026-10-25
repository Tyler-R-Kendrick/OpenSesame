import type { Organization } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

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
