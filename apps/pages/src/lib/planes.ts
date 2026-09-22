import type { HealthState } from "./identity.js";

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

export const planeSeams = {
  identityStatusLabel: identityStatusLabelDefault,
};

export function identityStatusLabel(identity: IdentityPlane): string {
  return planeSeams.identityStatusLabel(identity);
}
