/**
 * `identity.federation` — the Identity API's organization directory.
 *
 * Tenant discovery is public; joining needs a session, provisional guests
 * included. These are the four calls `lib/orgs.ts` declares as seams and
 * refuses by default: an installation that did not take this capability has
 * no directory to ask, and saying so is the honest answer rather than a
 * request to an endpoint that is not there.
 *
 * Egress: the configured Identity API only, through `identityJson`.
 */

import { isString } from "@opensesame/os-domain";
import {
  IdentityError,
  identityJson,
  isRemoteIdentityConfigured,
} from "@opensesame/app-core/lib/identity.js";
import {
  ORG_SLUG_RE,
  type OrgAuthMethodKind,
  type OrgMembership,
  type OrgTenant,
  orgSeams,
  setActiveOrgProfileId,
} from "@opensesame/app-core/lib/orgs.js";

export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

async function lookupOrgTenantDefault(slug: string): Promise<OrgTenant> {
  const normalized = normalizeSlug(slug);
  if (!ORG_SLUG_RE.test(normalized)) {
    throw new IdentityError("Enter an organization slug like acme-corp.", 400);
  }
  if (!isRemoteIdentityConfigured()) {
    throw new IdentityError("No sign-in service is connected.", 0);
  }
  return identityJson<OrgTenant>(
    `/v1/organizations/tenants/${encodeURIComponent(normalized)}`,
  );
}

/**
 * Home-realm discovery by email DOMAIN (never the address), against the
 * public `GET /v1/organizations/by-domain/:domain` twin of the login page's
 * realm router. Answers null for the uniform not-found — unknown, unverified,
 * and malformed domains are indistinguishable by design (anti-enumeration),
 * so "no organization uses that email domain" is all a caller can say.
 */
async function lookupOrgByDomainDefault(
  domain: string,
): Promise<OrgTenant | null> {
  if (!isRemoteIdentityConfigured()) {
    throw new IdentityError("No sign-in service is connected.", 0);
  }
  try {
    return await identityJson<OrgTenant>(
      `/v1/organizations/by-domain/${encodeURIComponent(domain)}`,
    );
  } catch (caught) {
    if (caught instanceof IdentityError && caught.status === 404) return null;
    throw caught;
  }
}

async function listOrgMembershipsDefault(): Promise<OrgMembership[]> {
  // Device host answers from the local directory; remote Identity from its store.
  const body = await identityJson<{ organizations: OrgMembership[] }>(
    "/v1/organizations",
  );
  return Array.isArray(body?.organizations) ? body.organizations : [];
}

async function joinOrgTenantDefault(
  slug: string,
  method: OrgAuthMethodKind,
  idToken: string,
): Promise<OrgMembership> {
  const normalized = normalizeSlug(slug);
  const joined = await identityJson<OrgMembership>(
    `/v1/organizations/tenants/${encodeURIComponent(normalized)}/join`,
    {
      method: "POST",
      body: JSON.stringify({ method, idToken }),
    },
  );
  if (isString(joined.id)) setActiveOrgProfileId(joined.id);
  return joined;
}

/** Install the real directory. Returns the revoke, which puts back the refusal. */
export function installOrgDirectory(): () => void {
  const previous = {
    lookupOrgTenant: orgSeams.lookupOrgTenant,
    lookupOrgByDomain: orgSeams.lookupOrgByDomain,
    listOrgMemberships: orgSeams.listOrgMemberships,
    joinOrgTenant: orgSeams.joinOrgTenant,
  };
  orgSeams.lookupOrgTenant = lookupOrgTenantDefault;
  orgSeams.lookupOrgByDomain = lookupOrgByDomainDefault;
  orgSeams.listOrgMemberships = listOrgMembershipsDefault;
  orgSeams.joinOrgTenant = joinOrgTenantDefault;
  let revoked = false;
  return () => {
    if (revoked) return;
    revoked = true;
    Object.assign(orgSeams, previous);
  };
}
