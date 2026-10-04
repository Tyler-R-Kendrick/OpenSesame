/**
 * The device Identity plane's route registry (ADR 0160).
 *
 * `device-identity-host.ts` answers the core of the Identity API itself:
 * health, provisional sessions, `/me` and claims. Everything else the device
 * can serve belongs to a capability, and a capability says so by registering
 * a *contribution* from its `activate` and unregistering it on dispose. There
 * is no shared slot to overwrite: two capabilities contribute side by side and
 * the first one that recognises a path answers it.
 *
 * A contribution names the route families it serves (the closed set below),
 * which is what `identityServes` reports for the device plane. Nothing here
 * has an import-time side effect, and nothing here imports an optional module:
 * the owning capability imports this file, never the reverse.
 */

/** Every kind of thing an Identity plane can be asked for. A closed set. */
export const IDENTITY_ROUTE_FAMILIES = [
  /** A principal and a bearer for it: `/v1/principals/*`, `/v1/health/*`. */
  "session",
  /** The trail of what happened: `/v1/audit/events`. */
  "audit",
  /** Requests addressed to a principal: `/v1/authorization-requests`. */
  "requests",
  /** Where a person is told something: push, inbox, routing. */
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
 * (a mail relay, an upstream directory, a public callback, a pass issuer). A
 * contribution that names one is refused: the truth table does not bend to a
 * capability that would like it to.
 */
export const DEVICE_NEVER_FAMILIES: readonly IdentityRouteFamily[] = [
  "mfa-codes",
  "org-signin",
  "federation-callback",
  "wallet",
];

/** The caller a request carries, as the host resolved it. Never a token. */
export type DeviceCaller = Readonly<{
  principalId: string;
  /** The tomb the principal's key lives in; empty before any vault exists. */
  tomb: string;
  /** A guest tomb's principal: provisional, isolated, never a member's. */
  guest: boolean;
}>;

export type DeviceRouteRequest = Readonly<{
  /** The path as asked, query included. */
  path: string;
  /** The path without its query. */
  bare: string;
  method: string;
  init: RequestInit;
  /** Null when the request carried no live bearer for this host. */
  caller: DeviceCaller | null;
}>;

/** What a vault session proves about how it was opened. */
export type DeviceAssurance = Readonly<{
  level: "provisional" | "phishing_resistant";
  /** When the proof was given, epoch ms. Required above `provisional`. */
  verifiedAt?: number;
}>;

export type DeviceRouteContribution = Readonly<{
  /** The owning capability's id; registering the same id again replaces. */
  id: string;
  /** The families this capability answers: what `identityServes` reports. */
  serves: readonly IdentityRouteFamily[];
  /**
   * Answer a path or return null to let the next contribution look. A
   * contribution may also answer a refusal for a family it does not serve.
   */
  dispatch(request: DeviceRouteRequest): Promise<Response | null>;
  /**
   * What this capability can vouch for about the unlocked vault. Absent, the
   * contribution vouches for nothing; the strongest answer across
   * contributions wins and the default is `provisional`.
   */
  assurance?(tomb: string): Promise<DeviceAssurance | null>;
}>;

const contributions = new Map<string, DeviceRouteContribution>();

function refuseFamily(
  id: string,
  family: IdentityRouteFamily,
  why: string,
): never {
  throw new TypeError(
    `Device identity route "${id}" names "${family}": ${why}`,
  );
}

/**
 * Add a capability's routes. Returns the unregister, which removes only this
 * registration, so a replaced contribution's late dispose cannot remove the
 * one that replaced it.
 */
export function registerDeviceRoutes(
  contribution: DeviceRouteContribution,
): () => void {
  for (const family of contribution.serves) {
    if (!IDENTITY_ROUTE_FAMILIES.includes(family)) {
      refuseFamily(contribution.id, family, "not a route family.");
    }
    if (DEVICE_CORE_FAMILIES.includes(family)) {
      refuseFamily(contribution.id, family, "the host core serves it.");
    }
    if (DEVICE_NEVER_FAMILIES.includes(family)) {
      refuseFamily(contribution.id, family, "a device cannot serve it.");
    }
  }
  contributions.set(contribution.id, contribution);
  return () => {
    if (contributions.get(contribution.id) === contribution) {
      contributions.delete(contribution.id);
    }
  };
}

/** The families registered contributions serve right now. */
export function registeredDeviceFamilies(): ReadonlySet<IdentityRouteFamily> {
  const families = new Set<IdentityRouteFamily>();
  for (const contribution of contributions.values()) {
    for (const family of contribution.serves) families.add(family);
  }
  return families;
}

/** The first contribution that recognises the path answers it. */
export async function dispatchDeviceRoute(
  request: DeviceRouteRequest,
): Promise<Response | null> {
  for (const contribution of [...contributions.values()]) {
    const answered = await contribution.dispatch(request);
    if (answered) return answered;
  }
  return null;
}

/** The strongest assurance any contribution vouches for. */
export async function deviceAssurance(tomb: string): Promise<DeviceAssurance> {
  let best: DeviceAssurance = { level: "provisional" };
  for (const contribution of [...contributions.values()]) {
    const vouched = await contribution.assurance?.(tomb);
    if (
      vouched?.level === "phishing_resistant" &&
      vouched.verifiedAt !== undefined &&
      best.level === "provisional"
    ) {
      best = vouched;
    }
  }
  return best;
}

/** Test seam: forget every contribution. */
export function resetDeviceRoutesForTests(): void {
  contributions.clear();
}
