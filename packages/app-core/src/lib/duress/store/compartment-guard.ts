/**
 * Guard shared-root project fork/switch when crossing duress compartment boundaries (STORE-A/F).
 * Non-duress / unenrolled devices: no-op so INV-01 preserves existing vault behavior.
 */

import { GUEST_TOMB } from "../../vfs.js";
import { isString } from "../json-boundary.js";
import { duressSessionFence } from "../session/fence.js";
import {
  isIndependentCompartment,
  loadCompartmentRegistry,
  rootAdmittedForTarget,
} from "./compartment-registry.js";

export type CompartmentSwitchRequest = Readonly<{
  sourceTomb: string;
  targetTomb: string;
  mode: "fork" | "open";
  /** Digest of the currently unlocked root — never the raw key. */
  sessionRootDigest?: string | null;
  ephemeral?: boolean;
}>;

/**
 * Refuse carries that would open an independently keyed compartment with a
 * sibling/shared production root, or move past an active incident fence.
 */
export function assertCompartmentSwitchAllowed(
  targetOrRequest: string | CompartmentSwitchRequest,
): void {
  const request: CompartmentSwitchRequest = isString(targetOrRequest)
    ? {
        sourceTomb: "",
        targetTomb: targetOrRequest,
        mode: "open",
        sessionRootDigest: null,
      }
    : targetOrRequest;

  if (request.ephemeral || request.targetTomb === GUEST_TOMB) {
    throw new Error("A guest session has no key to share.");
  }
  if (request.sourceTomb === request.targetTomb && request.sourceTomb) {
    return;
  }

  const fence = duressSessionFence.readFence();
  const registry = loadCompartmentRegistry();
  const fenceActive = fence.activeIncidentIds.length > 0;

  // No enrollment registry and no fence ⇒ legacy shared-root projects (INV-01).
  if (!registry && !fenceActive) return;

  if (fence.retiredDevice) {
    throw new Error("retired_device");
  }

  if (fenceActive) {
    assertFenceAdmitsTarget(fence.admittedCompartmentRefs, request.targetTomb);
    return;
  }

  assertIndependentTargetSwitch(
    registry,
    request,
    fence.admittedCompartmentRefs,
  );
}

function assertFenceAdmitsTarget(
  admitted: readonly string[],
  targetTomb: string,
): void {
  if (admitted.length === 0) {
    throw new Error("stale_session: no admitted compartment for switch");
  }
  if (!admitted.includes(targetTomb)) {
    throw new Error(
      "independent_keys_required: cannot carry current key across duress compartment boundary",
    );
  }
}

function assertIndependentTargetSwitch(
  registry: ReturnType<typeof loadCompartmentRegistry>,
  request: CompartmentSwitchRequest,
  admittedCompartmentRefs: readonly string[],
): void {
  if (
    request.mode === "fork" &&
    isIndependentCompartment(registry, request.targetTomb)
  ) {
    throw new Error(
      "independent_keys_required: refuse shared-root fork into independent compartment",
    );
  }
  if (!isIndependentCompartment(registry, request.targetTomb)) return;
  const admitted = rootAdmittedForTarget({
    registry,
    targetTomb: request.targetTomb,
    sessionRootDigest: request.sessionRootDigest ?? null,
    admittedCompartmentRefs,
    fenceActive: false,
  });
  if (!admitted) {
    throw new Error(
      "independent_keys_required: shared-root cannot open independent compartment",
    );
  }
}
