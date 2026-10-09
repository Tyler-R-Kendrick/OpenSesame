/**
 * Owner-only organization mutations, each demanding an `OrgOwner` proof about
 * the exact organization it touches (ADR 0178).
 *
 * A route used to run its owner check and then call a store with an id string,
 * and nothing tied the two together: a handler that forgot the check, or ran it
 * against a different id, compiled and shipped. These functions cannot be
 * called without the proof, and the proof cannot be about another organization.
 *
 * The stores underneath stay reachable (`ctx.stores`), so this is the path
 * routes take, not a seal. Reads, audit rows and request parsing stay in the
 * route; only the write that needs the owner's authority lives here.
 */

import type { Named } from "@gdp-ts/core";
import type {
  OrgLdapConfig,
  OrganizationMembership,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import type { OrganizationId } from "../lib/ids.js";
import type { OrgOwner } from "../proofs/org-owner.js";

type Org<O> = Named<O, OrganizationId>;
type EmailDomains = AppContext["stores"]["orgFederation"]["emailDomains"];
type EmailDomainRecord = Awaited<ReturnType<EmailDomains["claim"]>>;

export function claimEmailDomain<A, O>(
  ctx: AppContext,
  org: Org<O>,
  _proof: OrgOwner<A, O>,
  domain: string,
  verificationToken: string,
): Promise<EmailDomainRecord> {
  return ctx.stores.orgFederation.emailDomains.claim({
    organizationId: org.value,
    domain,
    verificationToken,
  });
}

export function markEmailDomainVerified<A, O>(
  ctx: AppContext,
  _org: Org<O>,
  _proof: OrgOwner<A, O>,
  domain: string,
): Promise<EmailDomainRecord | null> {
  return ctx.stores.orgFederation.emailDomains.markVerified(
    domain,
    ctx.clock(),
  );
}

export function releaseEmailDomain<A, O>(
  ctx: AppContext,
  org: Org<O>,
  _proof: OrgOwner<A, O>,
  domain: string,
): Promise<boolean> {
  return ctx.stores.orgFederation.emailDomains.remove(org.value, domain);
}

export function putLdapConfig<A, O>(
  ctx: AppContext,
  org: Org<O>,
  _proof: OrgOwner<A, O>,
  config: OrgLdapConfig,
): Promise<OrgLdapConfig> {
  if (config.organizationId !== org.value) {
    throw new Error("LDAP configuration is for a different organization");
  }
  return ctx.stores.orgFederation.ldapConfigs.put(config);
}

export function removeLdapConfig<A, O>(
  ctx: AppContext,
  org: Org<O>,
  _proof: OrgOwner<A, O>,
): Promise<boolean> {
  return ctx.stores.orgFederation.ldapConfigs.remove(org.value);
}

export function mintScimToken<A, O>(
  ctx: AppContext,
  org: Org<O>,
  _proof: OrgOwner<A, O>,
  tokenHash: string,
): ReturnType<AppContext["stores"]["scim"]["tokens"]["mint"]> {
  return ctx.stores.scim.tokens.mint(org.value, tokenHash);
}

export function revokeScimToken<A, O>(
  ctx: AppContext,
  org: Org<O>,
  _proof: OrgOwner<A, O>,
  tokenId: string,
): ReturnType<AppContext["stores"]["scim"]["tokens"]["revoke"]> {
  return ctx.stores.scim.tokens.revoke(org.value, tokenId);
}

export function writeOrganization<A, O>(
  ctx: AppContext,
  org: Org<O>,
  _proof: OrgOwner<A, O>,
  updated: Parameters<AppContext["stores"]["organizations"]["set"]>[1],
): Promise<void> {
  if (updated.id !== org.value) {
    throw new Error("organization row is for a different organization");
  }
  return Promise.resolve(ctx.stores.organizations.set(org.value, updated));
}

export function writeOrganizationMembership<A, O>(
  ctx: AppContext,
  org: Org<O>,
  _proof: OrgOwner<A, O>,
  membership: OrganizationMembership,
): Promise<OrganizationMembership> {
  if (membership.organizationId !== org.value) {
    throw new Error("membership is for a different organization");
  }
  return Promise.resolve(ctx.stores.organizationMemberships.upsert(membership));
}

export function removeOrganizationMembership<A, O>(
  ctx: AppContext,
  org: Org<O>,
  _proof: OrgOwner<A, O>,
  principalId: string,
): Promise<boolean> {
  return Promise.resolve(
    ctx.stores.organizationMemberships.remove(org.value, principalId),
  );
}
