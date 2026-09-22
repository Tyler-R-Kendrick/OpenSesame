/**
 * Coordinate pending vault writes/caches/generations with duress activation (STORE-E).
 * Guest and onboarding sessions are preserved — never fenced or flushed into production tombs.
 */

import { ProtectionSessionGuard } from "../../vault/protection/session-guard.js";
import { GUEST_TOMB } from "../../vfs.js";

export type ActivationHost = Readonly<{
  activeTomb: () => string;
  isGuestOrEphemeral: () => boolean;
  isOnboarding: () => boolean;
  flushPendingWrites: () => Promise<void>;
  cancelPendingOps: () => void;
  discardCaches: () => void;
  sessionGeneration: () => number;
}>;

export type CoordinationResult = Readonly<{
  skipped: boolean;
  reason?: "guest" | "onboarding" | "empty";
  generation: number;
}>;

const coordinatorGuard = new ProtectionSessionGuard();

/**
 * Flush in-flight persists, cancel protection enrollments, bump generation,
 * and discard tomb caches before applying a duress fence.
 */
export async function coordinateActivation(
  host: ActivationHost,
): Promise<CoordinationResult> {
  if (host.isGuestOrEphemeral() || host.activeTomb() === GUEST_TOMB) {
    return {
      skipped: true,
      reason: "guest",
      generation: host.sessionGeneration(),
    };
  }
  if (host.isOnboarding()) {
    return {
      skipped: true,
      reason: "onboarding",
      generation: host.sessionGeneration(),
    };
  }

  await host.flushPendingWrites();
  host.cancelPendingOps();
  host.discardCaches();
  const generation = coordinatorGuard.bump();
  return { skipped: false, generation };
}

export function activationCoordinatorGeneration(): number {
  return coordinatorGuard.generation;
}

/** True when a late callback captured an older generation. */
export function isStaleActivationGeneration(captured: number): boolean {
  return captured !== coordinatorGuard.generation;
}
