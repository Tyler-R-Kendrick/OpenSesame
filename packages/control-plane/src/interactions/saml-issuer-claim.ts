import type { AppContext } from "../context.js";
import { serializeKeyed } from "../serialize.js";
import { organizationIssuerApproved } from "../services/org-issuer-approval.js";
import { SamlAuthError } from "./saml-errors.js";

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
  if (!organizationIssuerApproved(ctx.config, entityId, organizationId)) {
    throw new SamlAuthError(
      "not_configured",
      "The operator has not approved this identity-provider issuer.",
    );
  }
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
