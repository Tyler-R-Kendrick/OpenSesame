import { useEffect, useState } from "react";
import {
  type HealthState,
  hostBase,
  identityBase,
  probeHost,
  probeIdentity,
  useIdentitySession,
} from "./identity.js";
import {
  hasRemoteHostPairing,
  pageIsLoopback,
  subscribeSettings,
} from "./settings.js";
import { isLoopbackUrl } from "./urls.js";

export type HostPlane = "live" | "loopback" | "down" | "unset" | "pending";
export type IdentityPlane = "connected" | "none" | "down";

export type PlaneStatus = {
  host: HostPlane;
  hostBase: string;
  identity: IdentityPlane;
  identityBase: string;
};

const PAGES_CANNOT_HOST_DEFAULT =
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

function hostStatusLabelDefault(host: HostPlane): string {
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

/** Whether the Connect-this-machine panel should be shown. */
function needsHostPairingDefault(status: PlaneStatus): boolean {
  if (status.host === "live" || status.host === "pending") return false;
  if (hasRemoteHostPairing() && status.host === "down") return false;
  if (status.host === "unset") return true;
  // Loopback Host is fine when the page itself is on loopback.
  if (status.host === "loopback") return !pageIsLoopback();
  return false;
}

function usePlaneStatusDefault(): PlaneStatus {
  const session = useIdentitySession();
  const [hostHealth, setHostHealth] = useState<HealthState>("unknown");
  const [identityHealth, setIdentityHealth] = useState<HealthState>("unknown");
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const host = hostBase();
  const identity = identityBase();

  useEffect(() => subscribeSettings(() => setSettingsEpoch((n) => n + 1)), []);

  // Re-probe when Settings change the bases or Identity connects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: host/identity/session/settingsEpoch are the retry triggers
  useEffect(() => {
    let cancelled = false;
    setHostHealth("unknown");
    setIdentityHealth("unknown");
    void Promise.all([probeHost(), probeIdentity()]).then(
      ([nextHost, nextIdentity]) => {
        if (cancelled) return;
        setHostHealth(nextHost);
        setIdentityHealth(nextIdentity);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [host, identity, session, settingsEpoch]);

  return {
    host: classifyHost(host, hostHealth),
    hostBase: host,
    identity: classifyIdentity(session !== null, identityHealth),
    identityBase: identity,
  };
}

export const planeSeams = {
  usePlaneStatus: usePlaneStatusDefault,
  PAGES_CANNOT_HOST: PAGES_CANNOT_HOST_DEFAULT,
  hostStatusLabel: hostStatusLabelDefault,
  identityStatusLabel: identityStatusLabelDefault,
  needsHostPairing: needsHostPairingDefault,
};

export function usePlaneStatus(): PlaneStatus {
  return planeSeams.usePlaneStatus();
}

export const PAGES_CANNOT_HOST = PAGES_CANNOT_HOST_DEFAULT;

export function hostStatusLabel(host: HostPlane): string {
  return planeSeams.hostStatusLabel(host);
}

export function identityStatusLabel(identity: IdentityPlane): string {
  return planeSeams.identityStatusLabel(identity);
}

export function needsHostPairing(status: PlaneStatus): boolean {
  return planeSeams.needsHostPairing(status);
}
