import type { Organization } from "@opensesame/os-domain";
import {
  ConflictError,
  type OrganizationStore,
  normalizeOrganizationRow,
  organizationClaimsIssuer,
} from "./interfaces.js";

/**
 * In-memory organization store — the former `AppStores.organizations` Map
 * behind the store interface, with `organizationSlugs` folded into
 * {@link MemoryOrganizationStore.getBySlug} (a second Map could disagree with
 * the first; a scan cannot).
 *
 * `set` normalizes the row so an optional field left empty reads back absent,
 * exactly as a Postgres NULL does.
 */
export class MemoryOrganizationStore
  extends Map<string, Organization>
  implements OrganizationStore
{
  override set(id: string, organization: Organization): this;
  override set(id: string, organization: Organization): void;
  override set(id: string, organization: Organization): this {
    const next = normalizeOrganizationRow({ ...organization, id });
    for (const other of this.values()) {
      if (other.id === id) continue;
      for (const issuer of [next.ssoIssuer, next.samlIssuer]) {
        if (issuer && organizationClaimsIssuer(other, issuer)) {
          throw new ConflictError("issuer_taken");
        }
      }
    }
    return super.set(id, next);
  }

  getBySlug(slug: string): Organization | undefined {
    for (const organization of this.values()) {
      if (organization.slug === slug) return organization;
    }
    return undefined;
  }

  findByIssuer(issuer: string): Organization | undefined {
    const matches = [...this.values()].filter((organization) =>
      organizationClaimsIssuer(organization, issuer),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  listByCreator(principalId: string): Organization[] {
    return [...this.values()].filter((org) => org.createdBy === principalId);
  }
}
