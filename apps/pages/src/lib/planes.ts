import { useEffect, useState } from "react";
import {
  type HealthState,
  hostBase,
  identityBase,
  probeHost,
  probeIdentity,
  useIdentitySession,
} from "./identity.js";
import { isLoopbackUrl } from "./urls.js";

export type HostPlane = "live" | "loopback" | "down";
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
  if (health === "reachable") return "live";
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
    case "loopback":
      return "Host not on this page";
    case "down":
      return "Host down";
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

export function usePlaneStatus(): PlaneStatus {
  const session = useIdentitySession();
  const [hostHealth, setHostHealth] = useState<HealthState>("unknown");
  const [identityHealth, setIdentityHealth] = useState<HealthState>("unknown");
  const host = hostBase();
  const identity = identityBase();

  // Re-probe when Settings change the bases or Identity connects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: host/identity/session are the retry triggers
  useEffect(() => {
    let cancelled = false;
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
  }, [host, identity, session]);

  return {
    host: classifyHost(host, hostHealth),
    hostBase: host,
    identity: classifyIdentity(session !== null, identityHealth),
    identityBase: identity,
  };
}
