/**
 * AUTH-B: intersect local IAM capabilities with profile/incident deny ceilings.
 * Never promotes via missing identity when a restricted fence is active (INV-11).
 */

import type { AccessCapability, AccessRole } from "../../local-rbac.js";
import type { FenceState } from "../session/fence.js";
import type { AccessContext } from "./context.js";

/** Map IAM admin capabilities onto deny/ceiling operation names. */
export const CAPABILITY_OPERATIONS = {
  manage_grants: ["manage_grants", "mint_grant"],
  manage_policies: ["manage_policies", "export_policy"],
  manage_identity: ["manage_identity"],
  manage_memberships: ["manage_memberships"],
} satisfies Record<AccessCapability, readonly string[]>;

export function capabilityDeniedByFence(
  capability: AccessCapability,
  fence: FenceState,
  ctx: AccessContext | null,
): boolean {
  if (fence.retiredDevice) return true;
  if (fence.activeIncidentIds.length === 0) return false;
  const ops = CAPABILITY_OPERATIONS[capability];
  for (const op of ops) {
    if (fence.denyOperations.includes(op)) return true;
    if (ctx?.claims.denyOperations.includes(op)) return true;
  }
  if (
    ctx &&
    (ctx.claims.presentation === "restricted" ||
      ctx.claims.presentation === "decoy" ||
      ctx.claims.presentation === "locked")
  ) {
    // Restricted presentations never retain operator IAM capabilities.
    return true;
  }
  return false;
}

/**
 * Effective role under an active fence: never elevate above guest when
 * presentation is restricted/decoy/locked. Ordinary sessions unchanged.
 */
export function roleUnderFence(
  ordinary: AccessRole,
  fence: FenceState,
  ctx: AccessContext | null,
): AccessRole {
  if (fence.activeIncidentIds.length === 0) return ordinary;
  if (
    ctx &&
    (ctx.claims.presentation === "restricted" ||
      ctx.claims.presentation === "decoy" ||
      ctx.claims.presentation === "locked")
  ) {
    return "guest";
  }
  return ordinary;
}

export function canAccessWithFence(
  role: AccessRole,
  capability: AccessCapability,
  fence: FenceState,
  ctx: AccessContext | null,
  ordinaryCanAccess: (
    role: AccessRole,
    capability: AccessCapability,
  ) => boolean,
): boolean {
  if (capabilityDeniedByFence(capability, fence, ctx)) return false;
  return ordinaryCanAccess(role, capability);
}
