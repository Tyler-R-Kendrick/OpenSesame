import type { Named } from "@gdp-ts/core";
import { ConflictError } from "@opensesame/database";
import type { Organization } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import type { OrganizationId } from "../lib/ids.js";
import type { OrganizationIssuerAdmission } from "../proofs/organization-issuer-admission.js";
import {
  type VerifiedOrgIdToken,
  originAudiences,
  verifyOrgIdToken,
} from "../routes/org-assertion.js";

export class OrganizationIssuerApprovalError extends Error {}

/** Persist only the exact row and tenant whose issuer configuration was proved. */
export function writeIssuerAdmittedOrganization<O, C>(
  ctx: AppContext,
  org: Named<O, OrganizationId>,
  row: Named<C, Organization>,
  _proof: OrganizationIssuerAdmission<O, C>,
): Promise<void> {
  if (row.value.id !== org.value)
    throw new Error("organization row is for a different organization");
  return Promise.resolve(ctx.stores.organizations.set(org.value, row.value));
}

export function organizationIssuerAllowlistFromEnv(
  env: NodeJS.ProcessEnv,
): string[] {
  return (env.OPENSESAME_ORGANIZATION_ISSUER_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** A tenant issuer may name exactly one organization. */
export async function issuerClaimed(
  ctx: AppContext,
  issuer: string | undefined,
  exceptOrganizationId?: string,
): Promise<boolean> {
  if (!issuer) return false;
  const owner = await ctx.stores.organizations.findByIssuer(issuer);
  return owner !== undefined && owner.id !== exceptOrganizationId;
}

/** Direct joins demand deployment approval as well as unambiguous ownership. */
export async function verifyAdmittedOrganizationAssertion<O, C>(
  ctx: AppContext,
  org: Named<O, OrganizationId>,
  configuration: Named<C, { ssoIssuer: string }>,
  _proof: OrganizationIssuerAdmission<O, C>,
  idToken: string,
): Promise<VerifiedOrgIdToken> {
  const owner = await ctx.stores.organizations.findByIssuer(
    configuration.value.ssoIssuer,
  );
  if (owner?.id !== org.value) throw new ConflictError("issuer_taken");
  return verifyOrgIdToken(idToken, configuration.value.ssoIssuer, {
    expectedAudiences: originAudiences(ctx.config),
    maxTokenAgeSec: 600,
    blockPrivateIssuerHosts: !ctx.config.allowDevDefaults,
  });
}
