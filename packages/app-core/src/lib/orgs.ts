/**
 * Org profiles on the current Identity principal.
 *
 * Tenant discovery is public. Joining requires a session — provisional guests
 * included. SSO and SAML are both OIDC issuers (ADR 0016); SAML is brokered.
 */

import { sessionStore } from "../ports.js";
import {
  assertAuthenticationSession,
  assertNotDecoySession,
  isRealAuthorityBlocked,
  withRealAuthority,
} from "./decoy-session.js";
import { IdentityError, identityBase } from "./identity.js";
import { VfsError, pinTombAuthority, readFile, writeFile } from "./vfs.js";

/** Legacy sessionStorage key — migrated into the tomb on unlock, then deleted. */
const LEGACY_ACTIVE_KEY = "opensesame:org-profile";
/** Sealed VFS path (within a tomb) holding the active org profile id. */
export const ORG_PROFILE_CONFIG_PATH = "config/org-profile";
export const GUEST_PROFILE_ID = "guest";
export const ORG_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type OrgAuthMethodKind = "sso" | "saml" | "ldap";

/** The methods a browser can run itself: an OIDC round-trip, and only that. */
export type OrgBrowserMethodKind = "sso" | "saml";

export type OrgAuthMethod = {
  kind: OrgAuthMethodKind;
  label: string;
  /**
   * The OIDC issuer this browser redirects to. Absent for methods with none:
   * native SAML is an XML round-trip run server-side, and LDAP is a credential
   * bind. Both are brokered by the Identity API instead (ADR 0056).
   */
  issuer?: string;
  /** Native SAML: configured IdP metadata, so there is no browser leg at all. */
  native?: boolean;
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

function emit(generation: number): void {
  for (const listener of listeners) {
    assertNotDecoySession(generation);
    listener();
  }
  assertNotDecoySession(generation);
}

export function subscribeOrgProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The active org profile, cached in memory for the unlocked session and
 * persisted sealed at `tomb/<name>/config/org-profile` (ADR 0063 — it left
 * sessionStorage with the encrypted VFS). While the vault is locked the
 * profile reads as the guest: every consumer is already post-unlock.
 */
let activeTomb: string | null = null;
let cachedProfileId: string | null = null;
let profileHydrated = false;
let profileGeneration = 0;
let cachedAuthority: (() => void) | null = null;

function readActiveProfileId(): string {
  try {
    assertNotDecoySession();
    cachedAuthority?.();
    return profileHydrated && cachedProfileId
      ? cachedProfileId
      : GUEST_PROFILE_ID;
  } catch {
    return GUEST_PROFILE_ID;
  }
}

function writeActiveProfileId(id: string): void {
  const generation = assertNotDecoySession();
  cachedAuthority?.();
  cachedAuthority ??= () => {
    assertNotDecoySession(generation);
  };
  profileGeneration += 1;
  cachedProfileId = id;
  profileHydrated = true;
  const tomb = activeTomb;
  if (tomb) {
    void writeFile(
      tomb,
      ORG_PROFILE_CONFIG_PATH,
      new TextEncoder().encode(id),
    ).catch(() => {
      /* the selection re-hydrates on the next unlock */
    });
  }
}

/**
 * Fill the in-memory selection from the tomb's sealed config, after the
 * unlock-time migration has moved any legacy sessionStorage copy.
 */
export async function hydrateOrgProfileFromVfs(
  tomb: string,
  originatingAuthority?: () => void,
): Promise<void> {
  assertAuthenticationSession();
  originatingAuthority?.();
  const assertAuthority = pinTombAuthority(tomb);
  if (activeTomb !== tomb) {
    profileGeneration += 1;
    cachedProfileId = null;
    profileHydrated = false;
    cachedAuthority = null;
  }
  activeTomb = tomb;
  const generation = profileGeneration;
  let id: string | null;
  try {
    const bytes = await readFile(tomb, ORG_PROFILE_CONFIG_PATH);
    const text = new TextDecoder().decode(bytes).trim();
    id = text.length > 0 ? text : null;
  } catch (error) {
    if (error instanceof VfsError && error.code === "locked") throw error;
    id = null;
  }
  assertAuthenticationSession();
  originatingAuthority?.();
  assertAuthority();
  if (generation !== profileGeneration || activeTomb !== tomb) return;
  cachedProfileId = id;
  cachedAuthority = assertAuthority;
  profileHydrated = true;
}

/** Lock: forget the decrypted selection and which tomb it belonged to. */
export function discardOrgProfile(): void {
  activeTomb = null;
  cachedProfileId = null;
  profileHydrated = false;
  cachedAuthority = null;
  profileGeneration += 1;
}

/** Legacy sessionStorage copy, for the unlock-time migration only. */
export function readLegacyOrgProfile(
  originatingAuthority?: () => void,
): string | null {
  if (originatingAuthority) {
    assertAuthenticationSession();
    originatingAuthority();
  } else assertNotDecoySession();
  try {
    const raw = sessionStore().getItem(LEGACY_ACTIVE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function clearLegacyOrgProfile(originatingAuthority?: () => void): void {
  if (originatingAuthority) {
    assertAuthenticationSession();
    originatingAuthority();
  } else assertNotDecoySession();
  try {
    sessionStore().removeItem(LEGACY_ACTIVE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

export function activeOrgProfileId(): string {
  return isRealAuthorityBlocked()
    ? GUEST_PROFILE_ID
    : orgSeams.activeOrgProfileId();
}

export function setActiveOrgProfileId(id: string): void {
  assertNotDecoySession();
  orgSeams.setActiveOrgProfileId(id);
}

function activeOrgProfileIdDefault(): string {
  return readActiveProfileId();
}

function setActiveOrgProfileIdDefault(id: string): void {
  const generation = assertNotDecoySession();
  writeActiveProfileId(id);
  assertNotDecoySession(generation);
  emit(generation);
}

/**
 * The four directory calls are the Identity API's, and an installation that
 * did not take `identity.federation` has no directory to ask. Their defaults
 * therefore refuse rather than reach for an endpoint — `orgs-directory.ts`
 * holds the implementations and that capability's runtime installs them.
 *
 * ADR 0090's rule applies as written: a screen is gated on what it actually
 * needs. The sign-in panel that routes an org method, the identifier field
 * that recognises a slug, and the profile this tab is on are all core and
 * stay here; only asking a service about a tenant is not.
 */
function noDirectory(): never {
  throw new IdentityError("No organization directory is available.", 0);
}

export const orgSeams = {
  activeOrgProfileId: activeOrgProfileIdDefault,
  setActiveOrgProfileId: setActiveOrgProfileIdDefault,
  lookupOrgTenant: async (_slug: string): Promise<OrgTenant> => noDirectory(),
  lookupOrgByDomain: async (_domain: string): Promise<OrgTenant | null> =>
    noDirectory(),
  listOrgMemberships: async (): Promise<OrgMembership[]> => noDirectory(),
  joinOrgTenant: async (
    _slug: string,
    _method: OrgAuthMethodKind,
    _idToken: string,
  ): Promise<OrgMembership> => noDirectory(),
};

export async function lookupOrgTenant(slug: string): Promise<OrgTenant> {
  return withRealAuthority(() => orgSeams.lookupOrgTenant(slug));
}

export async function lookupOrgByDomain(
  domain: string,
): Promise<OrgTenant | null> {
  return withRealAuthority(() => orgSeams.lookupOrgByDomain(domain));
}

export async function listOrgMemberships(): Promise<OrgMembership[]> {
  return withRealAuthority(() => orgSeams.listOrgMemberships());
}

export async function joinOrgTenant(
  slug: string,
  method: OrgAuthMethodKind,
  idToken: string,
): Promise<OrgMembership> {
  return withRealAuthority(() => orgSeams.joinOrgTenant(slug, method, idToken));
}

export type OrgAuthUpstream = {
  id: string;
  displayName: string;
  issuer: string;
  accountKind: string;
};

export function orgAuthUpstream(
  tenant: OrgTenant,
  method: OrgAuthMethod,
): OrgAuthUpstream {
  return {
    id: `org:${tenant.slug}:${method.kind}`,
    displayName: tenant.displayName,
    // A method with no browser-side issuer is brokered: the Identity API runs
    // the leg. Falling back to it keeps a no-issuer method from producing an
    // upstream pointed at nothing — callers still route through
    // `routeOrgMethod` first, so this is the floor, not the plan.
    issuer: method.issuer ?? identityBase(),
    accountKind:
      method.kind === "saml" ? "SAML" : method.kind === "ldap" ? "LDAP" : "SSO",
  };
}

export type OrgMethodRoute =
  /** This browser can run the whole OIDC round-trip against `issuer`. */
  | { via: "browser"; issuer: string; kind: OrgBrowserMethodKind }
  /** Only the Identity API can run this leg; sign in against it instead. */
  | { via: "brokered" };

/**
 * How a tenant method has to be started from a browser (D7/D9/D17).
 *
 * Native SAML and LDAP have no browser leg at all — one is an XML POST
 * ceremony with a server-side signature check, the other a directory bind —
 * and a method the server published without an issuer has, by definition,
 * nowhere for this tab to redirect to. All three go through the Identity API's
 * hosted login page, which finishes the leg and JIT-joins the org; this tab
 * then adopts the session that comes back (C13). The alternative — treating a
 * missing issuer as a broken button — is the one outcome that is not allowed.
 */
export function routeOrgMethod(method: OrgAuthMethod): OrgMethodRoute {
  if (method.kind !== "ldap" && method.issuer && !method.native) {
    return { via: "browser", issuer: method.issuer, kind: method.kind };
  }
  return { via: "brokered" };
}
