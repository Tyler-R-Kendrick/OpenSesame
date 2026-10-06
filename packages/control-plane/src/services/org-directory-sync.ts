/**
 * The owner's "sync now" for an organization's LDAP directory, demanding an
 * `OrgOwner` proof about that organization (ADR 0178).
 *
 * Kept apart from `org-admin.ts` on purpose: `interactions/ldap.ts` imports
 * `routes/organizations.ts`, which imports `org-admin.ts`, so reaching the sync
 * from there would close an import cycle.
 */

import type { Named } from "@gdp-ts/core";
import type { OrgLdapConfig } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  type LdapSyncSummary,
  syncLdapDirectory,
} from "../interactions/ldap.js";
import type { OrganizationId } from "../lib/ids.js";
import type { OrgOwner } from "../proofs/org-owner.js";

export function syncOrgDirectory<A, O>(
  ctx: AppContext,
  org: Named<O, OrganizationId>,
  _proof: OrgOwner<A, O>,
  config: OrgLdapConfig,
): Promise<LdapSyncSummary> {
  if (config.organizationId !== org.value) {
    throw new Error("LDAP configuration is for a different organization");
  }
  return syncLdapDirectory(ctx, config);
}
