import { identityBase } from "@opensesame/app-core/lib/identity.js";
import {
  type PlaneStatus,
  classifyIdentity,
} from "@opensesame/app-core/lib/planes.js";
import { useSettingsEpoch } from "../lib/use-settings.js";
import { useConnectivityMonitor } from "./connectivity-monitor.js";
import { useIdentitySession } from "./identity.js";

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

/** Test seam for the plane-status hook; the classification lives in lib/planes. */
export const planeHookSeams = {
  usePlaneStatus: usePlaneStatusDefault,
};

export function usePlaneStatus(): PlaneStatus {
  return planeHookSeams.usePlaneStatus();
}
