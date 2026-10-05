import { type Organization, overlapCast } from "@opensesame/os-domain";
import type { EventSealer } from "../event-seal.js";
import type * as schema from "../schema/index.js";
import { openSecretText, sealSecretText } from "../secret-seal.js";
import { normalizeOrganizationRow } from "./interfaces.js";

export function mapOrganization(
  row: typeof schema.organizations.$inferSelect,
  sealer?: EventSealer,
): Organization {
  return normalizeOrganizationRow({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    state: overlapCast(row.state),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.ssoIssuer ? { ssoIssuer: row.ssoIssuer } : undefined),
    ...(row.ssoClientId ? { ssoClientId: row.ssoClientId } : undefined),
    ...(row.ssoClientSecret
      ? {
          ssoClientSecret: sealer
            ? openSecretText(
                sealer,
                "organizations.sso_client_secret",
                row.id,
                row.ssoClientSecret,
              )
            : row.ssoClientSecret,
        }
      : undefined),
    ...(row.samlIssuer ? { samlIssuer: row.samlIssuer } : undefined),
    ...(row.samlMetadataUrl
      ? { samlMetadataUrl: row.samlMetadataUrl }
      : undefined),
    ...(row.samlMetadataXml
      ? { samlMetadataXml: row.samlMetadataXml }
      : undefined),
    ...(row.provisioningEnabled ? { provisioningEnabled: true } : undefined),
  });
}

export function organizationRowValues(
  organization: Organization,
  sealer?: EventSealer,
) {
  return {
    id: organization.id,
    slug: organization.slug,
    displayName: organization.displayName,
    state: organization.state,
    createdBy: organization.createdBy,
    ssoIssuer: organization.ssoIssuer ?? null,
    ssoClientId: organization.ssoClientId ?? null,
    ssoClientSecret:
      organization.ssoClientSecret && sealer
        ? sealSecretText(
            sealer,
            "organizations.sso_client_secret",
            organization.id,
            organization.ssoClientSecret,
          )
        : (organization.ssoClientSecret ?? null),
    samlIssuer: organization.samlIssuer ?? null,
    samlMetadataUrl: organization.samlMetadataUrl ?? null,
    samlMetadataXml: organization.samlMetadataXml ?? null,
    provisioningEnabled: organization.provisioningEnabled ?? false,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  };
}
