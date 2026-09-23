/**
 * WAL-B07 — same-origin Workers are not an independent origin boundary.
 * Assessment helpers must never advertise Worker isolation as root-key custody.
 */

export type IsolationClaim = {
  readonly mechanism: "same_origin_worker" | "dedicated_origin" | "hardware";
  readonly claimsIndependentOriginBoundary: boolean;
  readonly claimsRootKeyIsolation: boolean;
};

/** Capability assessment for a proposed Worker root-key isolation story. */
export function assessWorkerRootKeyIsolation(): IsolationClaim {
  return {
    mechanism: "same_origin_worker",
    claimsIndependentOriginBoundary: false,
    claimsRootKeyIsolation: false,
  };
}
