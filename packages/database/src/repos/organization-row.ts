import { type Organization, overlapCast } from "@opensesame/os-domain";
import type { EventSealer } from "../event-seal.js";
import type * as schema from "../schema/index.js";
import { openSecretText, sealSecretText } from "../secret-seal.js";
import { normalizeIssuer } from "./issuer-normalization.js";

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

export class OrganizationIssuerConflictError extends Error {
  override readonly name = "OrganizationIssuerConflictError";
  constructor() {
    super("That identity provider already belongs to another tenant.");
  }
}

/**
 * Row shape both organization stores agree on.
 *
 * Optional fields are present only when set — a Postgres NULL reads back as an
 * absent key, so the memory store must drop empty values too or a round-trip
 * that passes in memory fails against the database (and vice versa).
 */
export function normalizeOrganizationRow(
  organization: Organization,
): Organization {
  const row: Organization = {
    id: organization.id,
    slug: organization.slug,
    displayName: organization.displayName,
    state: organization.state,
    createdBy: organization.createdBy,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  };
  if (organization.ssoIssuer) row.ssoIssuer = organization.ssoIssuer;
  if (organization.ssoClientId) row.ssoClientId = organization.ssoClientId;
  if (organization.ssoClientSecret) {
    row.ssoClientSecret = organization.ssoClientSecret;
  }
  if (organization.samlIssuer) row.samlIssuer = organization.samlIssuer;
  if (organization.samlMetadataUrl) {
    row.samlMetadataUrl = organization.samlMetadataUrl;
  }
  if (organization.samlMetadataXml) {
    row.samlMetadataXml = organization.samlMetadataXml;
  }
  if (organization.provisioningEnabled) row.provisioningEnabled = true;
  return row;
}

/** True when either issuer column of `organization` names `issuer`. */
export function organizationClaimsIssuer(
  organization: Organization,
  issuer: string,
): boolean {
  const target = normalizeIssuer(issuer);
  if (!target) return false;
  return (
    (organization.ssoIssuer !== undefined &&
      normalizeIssuer(organization.ssoIssuer) === target) ||
    (organization.samlIssuer !== undefined &&
      normalizeIssuer(organization.samlIssuer) === target)
  );
}
