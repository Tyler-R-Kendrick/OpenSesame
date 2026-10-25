import { ConflictError } from "@opensesame/database";
import type { Organization } from "@opensesame/os-domain";
import type { ControlPlaneConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { normalizeIssuer } from "../interactions/registry.js";

type OrganizationIssuerConfiguration = Pick<
  Organization,
  "ssoIssuer" | "samlIssuer"
>;

/** Tenant ownership alone cannot authorize an issuer on this deployment. */
export function organizationIssuerApproved(
  config: ControlPlaneConfig,
  issuer: string,
  organizationId: string | undefined,
): boolean {
  if (!organizationId) return false;
  const normalized = normalizeIssuer(issuer);
  return (
    normalized.length > 0 &&
    (config.organizationIssuerAllowlist ?? []).some((approval) => {
      const separator = approval.indexOf("|");
      return (
        separator > 0 &&
        approval.slice(0, separator) === organizationId &&
        normalizeIssuer(approval.slice(separator + 1)) === normalized
      );
    })
  );
}

export function organizationIssuerApprovalError(
  config: ControlPlaneConfig,
  organizationId: string | undefined,
  ...issuers: (string | undefined)[]
): string | undefined {
  return issuers.some(
    (issuer) =>
      issuer && !organizationIssuerApproved(config, issuer, organizationId),
  )
    ? "The operator must approve this organization's identity-provider issuer."
    : undefined;
}

export class OrganizationIssuerApprovalError extends Error {}

export function assertOrganizationIssuerApproval(
  config: ControlPlaneConfig,
  organizationId: string | undefined,
  organization: OrganizationIssuerConfiguration,
): void {
  const message = organizationIssuerApprovalError(
    config,
    organizationId,
    organization.ssoIssuer,
    organization.samlIssuer,
  );
  if (message) throw new OrganizationIssuerApprovalError(message);
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

/** A direct tenant join must not bypass ambiguous legacy issuer ownership. */
export async function assertOrganizationIssuerAdmission(
  ctx: AppContext,
  organizationId: string,
  issuer: string,
): Promise<void> {
  assertOrganizationIssuerApproval(ctx.config, organizationId, {
    ssoIssuer: issuer,
  });
  const owner = await ctx.stores.organizations.findByIssuer(issuer);
  if (owner?.id !== organizationId) throw new ConflictError("issuer_taken");
}
