import {
  type OrganizationStores,
  createMemoryOrganizationStores,
} from "@opensesame/database";
import {
  type OrganizationIssuerAssignment,
  withApprovedOrganizationFederation,
} from "./organization-issuer-assignments.js";

export function withApprovedOrganizationStores(
  stores: OrganizationStores = createMemoryOrganizationStores(),
  assignments: readonly OrganizationIssuerAssignment[] = [],
): OrganizationStores {
  return {
    ...stores,
    organizations: withApprovedOrganizationFederation(
      stores.organizations,
      assignments,
    ),
  };
}
