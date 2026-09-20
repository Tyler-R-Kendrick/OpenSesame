/**
 * Whether a local share (or vault operator role) lets the current actor
 * reach a vault or item. Used by agent/webmcp surfaces that must honor
 * standing local grants.
 */

import { currentSession } from "./identity.js";
import type { AccessRole } from "./local-rbac.js";
import { canAccess, resolveCurrentAccessRole } from "./local-rbac.js";
import { type LocalShare, listLocalShares } from "./local-share-grants.js";

export type ShareReachRole = "read" | "write";

export const shareReachSeams = {
  resolveCurrentAccessRole,
  canAccess,
  currentSession,
  listLocalShares,
};

function principalsToMatch(explicit?: string): string[] {
  const out = new Set<string>();
  if (explicit) out.add(explicit);
  const session = shareReachSeams.currentSession();
  if (session?.principalId) out.add(session.principalId);
  return [...out];
}

function policyCovers(policy: string, wanted: ShareReachRole): boolean {
  if (wanted === "read")
    return (
      policy === "open" ||
      policy === "items" ||
      policy === "read" ||
      policy === "use"
    );
  return policy === "items" || policy === "use";
}

export async function shareAllows(
  tomb: string,
  resource: { kind: "vault" } | { kind: "item"; id: string },
  wanted: ShareReachRole,
  principalId?: string,
): Promise<boolean> {
  const role: AccessRole = await shareReachSeams.resolveCurrentAccessRole(tomb);
  if (shareReachSeams.canAccess(role, "manage_grants")) return true;

  const principals = principalsToMatch(principalId);
  if (principals.length === 0) return false;

  const shares: LocalShare[] = await shareReachSeams.listLocalShares(tomb);
  const now = Date.now();
  return shares.some((share) => {
    if (share.expiresAt <= now) return false;
    if (!principals.includes(share.principalId)) return false;
    if (!policyCovers(share.policy, wanted)) return false;
    if (resource.kind === "vault")
      return share.resourceKind === "vault" && share.resourceId === tomb;
    return (
      (share.resourceKind === "vault" && share.resourceId === tomb) ||
      (share.resourceKind === "item" && share.resourceId === resource.id)
    );
  });
}

export async function assertShareReach(
  tomb: string,
  resource: { kind: "vault" } | { kind: "item"; id: string },
  wanted: ShareReachRole,
  principalId?: string,
): Promise<void> {
  const allowed = await shareAllows(tomb, resource, wanted, principalId);
  if (!allowed) throw new Error("share_grant_denied");
}
