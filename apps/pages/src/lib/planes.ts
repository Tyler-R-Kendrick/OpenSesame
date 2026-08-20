import { useConnectivityMonitor } from "./connectivity-monitor.js";
import {
  type HealthState,
  hostBase,
  identityBase,
  useIdentitySession,
} from "./identity.js";
import { hasRemoteHostPairing, pageIsLoopback } from "./settings.js";
import { isLoopbackUrl } from "./urls.js";
import { useSettingsEpoch } from "./use-settings.js";

export type HostPlane = "live" | "loopback" | "down" | "unset" | "pending";
export type IdentityPlane = "connected" | "none" | "down";

export type PlaneStatus = {
  host: HostPlane;
  hostBase: string;
  identity: IdentityPlane;
  identityBase: string;
};

export const PAGES_CANNOT_HOST =
  "GitHub Pages cannot host the Host or Identity APIs. Point Settings at a Host you run, or use this page as the authority console only.";

export function classifyHost(base: string, health: HealthState): HostPlane {
  if (!base.trim()) return "unset";
  if (health === "reachable") return "live";
  // Keep prior pairing visible while the first probe is in flight — otherwise
  // every route remount looks like Host was never connected.
  if (health === "unknown") return "pending";
  return isLoopbackUrl(base) ? "loopback" : "down";
}

export function classifyIdentity(
  hasSession: boolean,
  health: HealthState,
): IdentityPlane {
  if (hasSession) return "connected";
  return health === "reachable" ? "none" : "down";
}

export function hostStatusLabel(host: HostPlane): string {
  switch (host) {
    case "live":
      return "Host live";
    case "pending":
      return "Host checking";
    case "loopback":
      return "Host not on this page";
    case "down":
      return "Host down";
    case "unset":
      return "Host not configured";
  }
}

export function identityStatusLabel(identity: IdentityPlane): string {
  switch (identity) {
    case "connected":
      return "Identity connected";
    case "none":
      return "No identity session";
    case "down":
      return "Identity down";
  }
}

/** Whether the Connect-this-machine panel should be shown. */
export function needsHostPairing(status: PlaneStatus): boolean {
  if (status.host === "live" || status.host === "pending") return false;
  if (hasRemoteHostPairing() && status.host === "down") return false;
  if (status.host === "unset") return true;
  // Loopback Host is fine when the page itself is on loopback.
  if (status.host === "loopback") return !pageIsLoopback();
  return false;
}

export function usePlaneStatus(): PlaneStatus {
  const session = useIdentitySession();
  // Reachability comes from the one supervisor, not from a probe of our own.
  // Six components call this hook; when each ran its own effect, a single
  // Settings visit cost sixteen Host requests and none of them ever repeated.
  const monitor = useConnectivityMonitor();
  // The bases are a separate concern: they can change without the verdict
  // about them changing, and this hook still has to re-render for that.
  useSettingsEpoch();
  const host = hostBase();
  const identity = identityBase();

  return {
    host: classifyHost(host, monitor.host.health),
    hostBase: host,
    identity: classifyIdentity(session !== null, monitor.identity.health),
    identityBase: identity,
  };
}
