import { useConnectivityMonitor } from "./connectivity-monitor.js";
import {
  type HealthState,
  identityBase,
  useIdentitySession,
} from "./identity.js";
import { useSettingsEpoch } from "./use-settings.js";

export type IdentityPlane = "connected" | "none" | "down";

export type PlaneStatus = {
  identity: IdentityPlane;
  identityBase: string;
};

export function classifyIdentity(
  hasSession: boolean,
  health: HealthState,
): IdentityPlane {
  if (hasSession) return "connected";
  return health === "reachable" ? "none" : "down";
}

function identityStatusLabelDefault(identity: IdentityPlane): string {
  switch (identity) {
    case "connected":
      return "Identity connected";
    case "none":
      return "No identity session";
    case "down":
      return "Identity down";
  }
}

function usePlaneStatusDefault(): PlaneStatus {
  const session = useIdentitySession();
  // Reachability comes from the one supervisor, not from a probe of our own.
  const monitor = useConnectivityMonitor();
  // The base is a separate concern: it can change without the verdict
  // about it changing, and this hook still has to re-render for that.
  useSettingsEpoch();
  const identity = identityBase();

  return {
    identity: classifyIdentity(session !== null, monitor.identity.health),
    identityBase: identity,
  };
}

export const planeSeams = {
  usePlaneStatus: usePlaneStatusDefault,
  identityStatusLabel: identityStatusLabelDefault,
};

export function usePlaneStatus(): PlaneStatus {
  return planeSeams.usePlaneStatus();
}

export function identityStatusLabel(identity: IdentityPlane): string {
  return planeSeams.identityStatusLabel(identity);
}
