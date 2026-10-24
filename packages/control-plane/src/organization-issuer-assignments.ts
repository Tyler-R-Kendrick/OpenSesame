import {
  OrganizationIssuerUrlSchema,
  SamlEntityIdSchema,
  SamlMetadataUrlSchema,
  SamlMetadataXmlSchema,
} from "@opensesame/contracts";
import type { OrganizationStore } from "@opensesame/database";
import type { Organization } from "@opensesame/os-domain";
import { z } from "zod";
import { normalizeIssuer } from "./interactions/issuer-normalization.js";

const AssignmentSchema = z
  .object({
    organizationId: z.string().min(1),
    ssoIssuer: OrganizationIssuerUrlSchema.optional(),
    samlIssuer: SamlEntityIdSchema.optional(),
    samlMetadataUrl: SamlMetadataUrlSchema.optional(),
    samlMetadataXml: SamlMetadataXmlSchema.optional(),
  })
  .strict();
export type OrganizationIssuerAssignment = z.infer<typeof AssignmentSchema>;

/** Server-only operator configuration, never a tenant-submitted allowlist. */
export function parseOrganizationIssuerAssignments(value: string | undefined) {
  const assignments = z
    .array(AssignmentSchema)
    .parse(JSON.parse(value ?? "[]"));
  const organizations = new Set<string>();
  const issuers = new Map<string, string>();
  for (const assignment of assignments) {
    if (organizations.has(assignment.organizationId))
      throw new Error("Duplicate organization issuer assignment");
    organizations.add(assignment.organizationId);
    if (
      (assignment.samlMetadataUrl && assignment.samlMetadataXml) ||
      ((assignment.samlMetadataUrl || assignment.samlMetadataXml) &&
        !assignment.samlIssuer)
    ) {
      throw new Error(
        "SAML assignment requires an explicit entityID and one metadata source",
      );
    }
    for (const issuer of [assignment.ssoIssuer, assignment.samlIssuer]) {
      if (!issuer) continue;
      const normalized = normalizeIssuer(issuer);
      if (
        !normalized ||
        (issuers.has(normalized) &&
          issuers.get(normalized) !== assignment.organizationId)
      ) {
        throw new Error("An issuer can be assigned to only one organization");
      }
      issuers.set(normalized, assignment.organizationId);
    }
  }
  return assignments;
}
function sameIssuer(value: string | undefined, approved: string | undefined) {
  return Boolean(
    value && approved && normalizeIssuer(value) === normalizeIssuer(approved),
  );
}
function approvedSsoFields(
  ssoIssuer: string | undefined,
  ssoClientId: string | undefined,
  ssoClientSecret: string | undefined,
  approved?: OrganizationIssuerAssignment,
) {
  if (!ssoIssuer || !sameIssuer(ssoIssuer, approved?.ssoIssuer)) return {};
  const fields: Pick<
    Organization,
    "ssoIssuer" | "ssoClientId" | "ssoClientSecret"
  > = { ssoIssuer };
  if (ssoClientId) fields.ssoClientId = ssoClientId;
  if (ssoClientSecret) fields.ssoClientSecret = ssoClientSecret;
  return fields;
}
/** Legacy/unapproved rows retain organization access, but confer no IdP authority. */
export function approvedOrganizationFederation(
  organization: Organization,
  assignments: readonly OrganizationIssuerAssignment[] = [],
): Organization {
  const approved = assignments.find(
    (entry) => entry.organizationId === organization.id,
  );
  const {
    ssoIssuer,
    ssoClientId,
    ssoClientSecret,
    samlIssuer,
    samlMetadataUrl,
    samlMetadataXml,
    ...base
  } = organization;
  const samlApproved =
    sameIssuer(samlIssuer, approved?.samlIssuer) &&
    samlMetadataUrl === approved?.samlMetadataUrl &&
    samlMetadataXml === approved?.samlMetadataXml;
  const result: Organization = {
    ...base,
    ...approvedSsoFields(ssoIssuer, ssoClientId, ssoClientSecret, approved),
  };
  if (samlApproved && samlIssuer) {
    result.samlIssuer = samlIssuer;
    if (samlMetadataUrl) result.samlMetadataUrl = samlMetadataUrl;
    if (samlMetadataXml) result.samlMetadataXml = samlMetadataXml;
  }
  return result;
}
export function hasUnapprovedOrganizationFederation(
  organization: Organization,
  assignments: readonly OrganizationIssuerAssignment[] = [],
): boolean {
  const approved = approvedOrganizationFederation(organization, assignments);
  const fields = [
    "ssoIssuer",
    "samlIssuer",
    "samlMetadataUrl",
    "samlMetadataXml",
  ] as const;
  return fields.some((key) => organization[key] !== approved[key]);
}
/** One projection for every consumer, on both memory and durable backends. */
export function withApprovedOrganizationFederation(
  store: OrganizationStore,
  assignments: readonly OrganizationIssuerAssignment[] = [],
): OrganizationStore {
  const project = (organization: Organization | undefined) =>
    organization
      ? approvedOrganizationFederation(organization, assignments)
      : undefined;
  return {
    get: async (id) => project(await store.get(id)),
    getBySlug: async (slug) => project(await store.getBySlug(slug)),
    set: (id, organization) => store.set(id, organization),
    listByCreator: async (id) =>
      (await store.listByCreator(id)).map((organization) =>
        approvedOrganizationFederation(organization, assignments),
      ),
    findByIssuer: async (issuer) => {
      const normalized = normalizeIssuer(issuer);
      // Resolve from operator assignments rather than a first-match raw row;
      // a historical unproven claim cannot block an approved tenant.
      for (const assignment of assignments) {
        if (
          ![assignment.ssoIssuer, assignment.samlIssuer].some((candidate) =>
            sameIssuer(normalized, candidate),
          )
        )
          continue;
        const organization = project(
          await store.get(assignment.organizationId),
        );
        if (
          organization &&
          [organization.ssoIssuer, organization.samlIssuer].some((candidate) =>
            sameIssuer(normalized, candidate),
          )
        )
          return organization;
      }
      return undefined;
    },
  };
}
