import type { OrganizationRole, ProjectRole } from "../types.js";
import type { DomainRole } from "./control.js";

/**
 * The frozen wire strings both planes use.
 *
 * These mirror the `DOMAIN_*_WIRE` tables in
 * `crates/domain/src/access_domain/bridge.rs`, which are themselves asserted
 * against the Rust serde output. Together the two sides are what stop an
 * access-domain document written by the host plane from meaning something else
 * to the client plane.
 */
export const DOMAIN_ROLE_WIRE = ["member", "admin", "owner"] as const;
export const DOMAIN_SCOPE_WIRE = ["domain_only", "subtree"] as const;
export const DOMAIN_INHERITANCE_WIRE = ["inherit", "isolated"] as const;
export const DOMAIN_LIFETIME_WIRE = ["permanent", "temporary"] as const;
export const DOMAIN_PROJECT_KIND_WIRE = [
  "personal",
  "standard",
  "temporary",
] as const;

/**
 * The domain rung an ADR 0038 project membership already carries.
 *
 * A conversion rather than a parallel vocabulary: the ladders are the same
 * three rungs, so a project owner is a domain owner and nothing has to be
 * decided twice.
 */
export function domainRoleFromProjectRole(role: ProjectRole): DomainRole {
  return role;
}

export function projectRoleFromDomainRole(role: DomainRole): ProjectRole {
  return role;
}

export function domainRoleFromOrganizationRole(
  role: OrganizationRole,
): DomainRole {
  return role;
}

export function organizationRoleFromDomainRole(
  role: DomainRole,
): OrganizationRole {
  return role;
}
