/**
 * Org profiles on the current Identity principal.
 *
 * Tenant discovery is public. Joining requires a session — provisional guests
 * included. SSO and SAML are both OIDC issuers (ADR 0016); SAML is brokered.
 */

import { isString } from "@opensesame/os-domain";
import { IdentityError, identityBase, identityJson } from "./identity.js";

const ACTIVE_KEY = "opensesame:org-profile";
export const GUEST_PROFILE_ID = "guest";
export const ORG_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type OrgAuthMethodKind = "sso" | "saml";

export type OrgAuthMethod = {
  kind: OrgAuthMethodKind;
  label: string;
  issuer: string;
};

export type OrgTenant = {
  slug: string;
  displayName: string;
  state: string;
  authMethods: OrgAuthMethod[];
};

export type OrgMembership = {
  id: string;
  slug: string;
  displayName: string;
  role: string;
  state: string;
  ssoIssuer?: string;
  samlIssuer?: string;
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeOrgProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readActiveProfileId(): string {
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    return raw && raw.length > 0 ? raw : GUEST_PROFILE_ID;
  } catch {
    return GUEST_PROFILE_ID;
  }
}

function writeActiveProfileId(id: string): void {
  // Profile selection is not vault material; it only has to survive this tab.
  // ast-grep-ignore: ts-localstorage-set
  sessionStorage.setItem(ACTIVE_KEY, id);
}

export function activeOrgProfileId(): string {
  return orgSeams.activeOrgProfileId();
}

export function setActiveOrgProfileId(id: string): void {
  orgSeams.setActiveOrgProfileId(id);
}

function activeOrgProfileIdDefault(): string {
  return readActiveProfileId();
}

function setActiveOrgProfileIdDefault(id: string): void {
  writeActiveProfileId(id);
  emit();
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

async function lookupOrgTenantDefault(slug: string): Promise<OrgTenant> {
  const normalized = normalizeSlug(slug);
  if (!ORG_SLUG_RE.test(normalized)) {
    throw new IdentityError("Enter an organization slug like acme-corp.", 400);
  }
  if (!identityBase()) {
    throw new IdentityError(
      "No Identity API is configured. Set the Identity URL in Settings.",
      0,
    );
  }
  return identityJson<OrgTenant>(
    `/v1/organizations/tenants/${encodeURIComponent(normalized)}`,
  );
}

async function listOrgMembershipsDefault(): Promise<OrgMembership[]> {
  if (!identityBase()) return [];
  const body = await identityJson<{ organizations: OrgMembership[] }>(
    "/v1/organizations",
  );
  return Array.isArray(body.organizations) ? body.organizations : [];
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

export const orgSeams = {
  activeOrgProfileId: activeOrgProfileIdDefault,
  setActiveOrgProfileId: setActiveOrgProfileIdDefault,
  lookupOrgTenant: lookupOrgTenantDefault,
  listOrgMemberships: listOrgMembershipsDefault,
  joinOrgTenant: joinOrgTenantDefault,
};

export async function lookupOrgTenant(slug: string): Promise<OrgTenant> {
  return orgSeams.lookupOrgTenant(slug);
}

export async function listOrgMemberships(): Promise<OrgMembership[]> {
  return orgSeams.listOrgMemberships();
}

export async function joinOrgTenant(
  slug: string,
  method: OrgAuthMethodKind,
  idToken: string,
): Promise<OrgMembership> {
  return orgSeams.joinOrgTenant(slug, method, idToken);
}

export function orgAuthUpstream(
  tenant: OrgTenant,
  method: OrgAuthMethod,
): {
  id: string;
  displayName: string;
  issuer: string;
  accountKind: string;
} {
  return {
    id: `org:${tenant.slug}:${method.kind}`,
    displayName: tenant.displayName,
    issuer: method.issuer,
    accountKind: method.kind === "saml" ? "SAML" : "SSO",
  };
}
