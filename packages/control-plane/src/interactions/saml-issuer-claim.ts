import { type Named, name } from "@gdp-ts/core";
import type { AppContext } from "../context.js";
import { type OrganizationId, organizationId as orgId } from "../lib/ids.js";
import {
  type OrganizationIssuerAdmission,
  organizationIssuerAdmission,
} from "../proofs/organization-issuer-admission.js";
import { serializeKeyed } from "../serialize.js";
import { SamlAuthError } from "./saml-errors.js";
import {
  type SamlAssertionResult,
  resolveIdpMetadata,
  samlOrgConfig,
} from "./saml.js";

/**
 * One IdP entityID belongs to one tenant.
 *
 * An entityID that is not already recorded on the organization row is adopted
 * on first use, inside the same serialized claim as the uniqueness check. Two
 * tenants configured with the same metadata therefore cannot both accept that
 * IdP's assertions: the first resolves the entityID, writes it to its row, and
 * the second's lookup finds the existing owner and refuses. Without the write,
 * an empty `samlIssuer` would make every assertion look unclaimed forever.
 */
export async function claimSamlEntityId(
  ctx: AppContext,
  organizationId: string,
  entityId: string,
): Promise<void> {
  return name(
    orgId(organizationId),
    { samlIssuer: entityId },
    (org, configuration) => {
      const verdict = organizationIssuerAdmission(
        ctx.config,
        org,
        configuration,
      );
      if (!verdict.ok)
        throw new SamlAuthError(
          "not_configured",
          "The operator has not approved this identity-provider issuer.",
        );
      return claimAdmittedSamlEntityId(ctx, org, configuration, verdict.proof);
    },
  );
}

export async function claimAdmittedSamlEntityId<O, C>(
  ctx: AppContext,
  org: Named<O, OrganizationId>,
  configuration: Named<C, { samlIssuer: string }>,
  _proof: OrganizationIssuerAdmission<O, C>,
): Promise<void> {
  const organizationId = org.value;
  const entityId = configuration.value.samlIssuer;
  await serializeKeyed(
    ctx.stores.principalMutations,
    `saml-entity:${entityId}`,
    async () => {
      const owner = await ctx.stores.organizations.findByIssuer(entityId);
      if (owner && owner.id !== organizationId) {
        throw new SamlAuthError(
          "not_configured",
          "This identity provider belongs to another tenant.",
        );
      }
      const organization = await ctx.stores.organizations.get(organizationId);
      if (
        !organization ||
        organization.state === "suspended" ||
        organization.state === "deleted"
      ) {
        throw new SamlAuthError(
          "not_configured",
          "No organization on this server accepts that identity provider.",
        );
      }
      if (organization.samlIssuer === entityId) {
        if (!owner)
          throw new SamlAuthError(
            "not_configured",
            "This identity-provider issuer has ambiguous tenant ownership.",
          );
        return;
      }
      if (organization.samlIssuer) {
        throw new SamlAuthError(
          "metadata_unavailable",
          "The organization's SAML metadata does not match its configured entityID.",
        );
      }
      await ctx.stores.organizations.set(organization.id, {
        ...organization,
        samlIssuer: entityId,
        updatedAt: ctx.clock(),
      });
    },
  );
}

/**
 * The issuer recorded on a SAML identity row is the IdP's entityID, resolved
 * from the tenant's configuration rather than from the assertion — the row has
 * to name what this deployment trusts, not what the document claimed.
 */
export async function issuerForResult(
  ctx: AppContext,
  result: SamlAssertionResult,
): Promise<string | undefined> {
  const organization = await ctx.stores.organizations.get(
    result.organizationId,
  );
  if (
    !organization ||
    organization.state === "deleted" ||
    organization.state === "suspended"
  ) {
    return undefined;
  }
  const cfg = samlOrgConfig(organization);
  if (!cfg) return undefined;
  try {
    const issuer =
      cfg.idpEntityId || (await resolveIdpMetadata(ctx, cfg)).entityId;
    return name(
      orgId(result.organizationId),
      { samlIssuer: issuer },
      (org, configuration) => {
        const verdict = organizationIssuerAdmission(
          ctx.config,
          org,
          configuration,
        );
        return verdict.ok
          ? admittedSamlIssuer(org, configuration, verdict.proof)
          : undefined;
      },
    );
  } catch {
    return undefined;
  }
}

function admittedSamlIssuer<O, C>(
  _org: Named<O, OrganizationId>,
  configuration: Named<C, { samlIssuer: string }>,
  _proof: OrganizationIssuerAdmission<O, C>,
): string {
  return configuration.value.samlIssuer;
}
