/**
 * The device Identity plane's route registry (ADR 0160).
 *
 * `device-identity-host.ts` answers the core of the Identity API itself:
 * health, provisional sessions, `/me` and claims. Everything else the device
 * can serve belongs to a capability, and a capability says so by registering
 * a *contribution* from its `activate` and unregistering it on dispose. There
 * is no shared slot to overwrite.
 *
 * The table is real, not a declaration. A path belongs to exactly one route
 * family (`familyOfPath`); a family has at most one owner; a contribution
 * answers only the paths of the families it registered a handler for; a family
 * counts as served only while a handler for it is registered. A path in no
 * family, or in a family nobody owns, is not served, whoever would like to
 * answer it. Nothing here has an import-time side effect, and nothing here
 * imports an optional module: the owning capability imports this file, never
 * the reverse.
 */

import { isFunction } from "@opensesame/os-domain";

/** Every kind of thing an Identity plane can be asked for. A closed set. */
export const IDENTITY_ROUTE_FAMILIES = [
  /** A principal and a bearer for it: `/v1/principals/*`, `/v1/health/*`. */
  "session",
  /** The trail of what happened: `/v1/audit/events`. */
  "audit",
  /** Requests addressed to a principal: `/v1/authorization-requests`. */
  "requests",
  /** Where a person is told something: preferences, channels, push. */
  "notifications",
  /** People, agents, organizations, projects, applications. */
  "directory",
  /** Email and text codes: `/v1/mfa/code/*`. Needs a mail or SMS sender. */
  "mfa-codes",
  /** Organization SSO, SAML, LDAP, magic link. Needs an upstream directory. */
  "org-signin",
  /** A federated provider's callback URL. Needs a reachable server. */
  "federation-callback",
  /** Wallet passes and their provisioning. Needs the wallet's service. */
  "wallet",
] as const;

export type IdentityRouteFamily = (typeof IDENTITY_ROUTE_FAMILIES)[number];

/** Served by the host core itself, whichever capabilities are on. */
export const DEVICE_CORE_FAMILIES: readonly IdentityRouteFamily[] = ["session"];

/**
 * Families a device cannot serve, because each needs a server in the world
 * (a mail relay, an upstream directory, a publicly reachable callback, a pass
 * issuer). A contribution that names one is refused, and the host answers
 * their paths itself.
 */
export const DEVICE_NEVER_FAMILIES: readonly IdentityRouteFamily[] = [
  "mfa-codes",
  "org-signin",
  "federation-callback",
  "wallet",
];

/**
 * Path prefixes by family, most specific first. `/v1/organizations/tenants`
 * is a sign-in lookup and `/v1/organizations` a directory list, so the longer
 * one must win; a prefix matches the path itself and anything under it.
 */
const PATH_FAMILIES: readonly (readonly [string, IdentityRouteFamily])[] = [
  ["/v1/organizations/tenants", "org-signin"],
  ["/v1/organizations/by-domain", "org-signin"],
  ["/v1/auth", "org-signin"],
  ["/v1/mfa/code", "mfa-codes"],
  ["/v1/federation", "federation-callback"],
  ["/v1/wallet", "wallet"],
  ["/v1/audit/events", "audit"],
  ["/v1/authorization-requests", "requests"],
  ["/v1/interactions", "requests"],
  ["/v1/notification-preferences", "notifications"],
  ["/v1/notification-channels", "notifications"],
  ["/v1/oauth/clients", "directory"],
  ["/v1/organizations", "directory"],
  ["/v1/agents", "directory"],
  ["/v1/projects", "directory"],
  ["/v1/principals", "session"],
  ["/v1/health", "session"],
  ["/v1/claims", "session"],
];

/** The family a path (query ignored) belongs to, or null for none. */
export function familyOfPath(path: string): IdentityRouteFamily | null {
  const bare = path.split("?")[0] ?? path;
  for (const [prefix, family] of PATH_FAMILIES) {
    if (bare === prefix || bare.startsWith(`${prefix}/`)) return family;
  }
  return null;
}

/** The caller a request carries, as the host resolved it. Never a token. */
export type DeviceCaller = Readonly<{
  principalId: string;
  /** The tomb the principal's key lives in; empty before any vault exists. */
  tomb: string;
  /** A guest tomb's principal: provisional, isolated, never a member's. */
  guest: boolean;
}>;

/**
 * What a handler is handed. There are no headers in it: the bearer was
 * resolved to `caller` by the host and goes no further.
 */
export type DeviceRouteRequest = Readonly<{
  /** The path as asked, query included. */
  path: string;
  /** The path without its query. */
  bare: string;
  method: string;
  family: IdentityRouteFamily;
  /** A string request body as sent, else null. */
  body: string | null;
  /** Null when the request carried no live bearer for this host. */
  caller: DeviceCaller | null;
}>;

/** Answer a path of the family, or null to leave it unserved (501). */
export type DeviceRouteHandler = (
  request: DeviceRouteRequest,
) => Promise<Response | null>;

export type DeviceRouteContribution = Readonly<{
  /** The owning capability's id; registering the same id again replaces. */
  id: string;
  /** One handler per family the capability serves. Those keys are `serves`. */
  routes: Readonly<Partial<Record<IdentityRouteFamily, DeviceRouteHandler>>>;
}>;

const contributions = new Map<string, DeviceRouteContribution>();
const listeners = new Set<() => void>();
const faults: { id: string; family: IdentityRouteFamily }[] = [];

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function refuse(id: string, family: string, why: string): never {
  throw new TypeError(
    `Device identity route "${id}" names "${family}": ${why}`,
  );
}

function servedFamilies(
  contribution: DeviceRouteContribution,
): IdentityRouteFamily[] {
  return IDENTITY_ROUTE_FAMILIES.filter((family) =>
    isFunction(contribution.routes[family]),
  );
}

function ownerOf(
  family: IdentityRouteFamily,
  except?: string,
): DeviceRouteContribution | undefined {
  for (const contribution of contributions.values()) {
    if (contribution.id === except) continue;
    if (servedFamilies(contribution).includes(family)) return contribution;
  }
  return undefined;
}

/**
 * Add a capability's routes. Throws, registering nothing, when a family is
 * not one the device may serve, has no handler, or already has another owner:
 * a second registrant cannot shadow the first. Returns the unregister, which
 * removes only this registration.
 */
export function registerDeviceRoutes(
  contribution: DeviceRouteContribution,
): () => void {
  for (const family of Object.keys(contribution.routes)) {
    if (!IDENTITY_ROUTE_FAMILIES.some((known) => known === family)) {
      refuse(contribution.id, family, "not a route family.");
    }
  }
  for (const family of IDENTITY_ROUTE_FAMILIES) {
    const handler = contribution.routes[family];
    if (handler === undefined) continue;
    if (!isFunction(handler)) {
      refuse(contribution.id, family, "has no handler.");
    }
    if (DEVICE_CORE_FAMILIES.includes(family)) {
      refuse(contribution.id, family, "the host core serves it.");
    }
    if (DEVICE_NEVER_FAMILIES.includes(family)) {
      refuse(contribution.id, family, "a device cannot serve it.");
    }
    const owner = ownerOf(family, contribution.id);
    if (owner) {
      refuse(contribution.id, family, `"${owner.id}" already serves it.`);
    }
  }
  contributions.set(contribution.id, contribution);
  notify();
  return () => {
    if (contributions.get(contribution.id) === contribution) {
      contributions.delete(contribution.id);
      notify();
    }
  };
}

/** The families registered handlers serve right now. */
export function registeredDeviceFamilies(): ReadonlySet<IdentityRouteFamily> {
  const families = new Set<IdentityRouteFamily>();
  for (const contribution of contributions.values()) {
    for (const family of servedFamilies(contribution)) families.add(family);
  }
  return families;
}

/**
 * Be told when what the device serves changes: a capability registering after
 * a panel first drew, or leaving. Returns the unsubscribe.
 */
export function subscribeDeviceRoutes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Route a request to the one handler that owns its family. Null means not
 * served: the path is in no family, nobody owns it, or the owner declined. A
 * handler that throws answers 500 and is recorded by id and family only; it
 * never takes another contribution down with it.
 */
export async function dispatchDeviceRoute(
  request: Omit<DeviceRouteRequest, "family">,
): Promise<Response | null> {
  const family = familyOfPath(request.bare);
  if (family === null) return null;
  const owner = ownerOf(family);
  const handler = owner?.routes[family];
  if (!owner || !handler) return null;
  try {
    return await handler({ ...request, family });
  } catch {
    faults.push({ id: owner.id, family });
    if (faults.length > 50) faults.shift();
    return new Response(
      JSON.stringify({
        error: "device_identity",
        hint: "A device identity route failed.",
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

/** Which contribution faulted and where, never what it saw. Bounded. */
export function deviceRouteFaults(): readonly {
  id: string;
  family: IdentityRouteFamily;
}[] {
  return [...faults];
}

/** Test seam: forget every contribution and fault. */
export function resetDeviceRoutesForTests(): void {
  contributions.clear();
  faults.length = 0;
  notify();
}
