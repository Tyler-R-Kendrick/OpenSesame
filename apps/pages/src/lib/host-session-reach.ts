/**
 * Whether a Host-mirrored share (or vault operator role) lets this principal
 * reach a vault or item. Used by agent/webmcp surfaces that must honor ADR
 * 0079 grants, not only the offline vault-session dogfood.
 */

import { hostPrincipalId } from "./host-ids.js";
import {
  type HostSessionBookmark,
  listHostSessionBookmarks,
} from "./host-shared-session-store.js";
import { currentSession } from "./identity.js";
import type { AccessRole } from "./local-rbac.js";
import { canAccess, resolveCurrentAccessRole } from "./local-rbac.js";
import { type LocalShare, listLocalShares } from "./local-share-grants.js";

export type HostReachRole = "read" | "write";

export const hostSessionReachSeams = {
  listHostSessionBookmarks,
  resolveCurrentAccessRole,
  canAccess,
  currentSession,
  listLocalShares,
};

function principalsToMatch(explicit?: string): string[] {
  const out = new Set<string>();
  if (explicit) {
    out.add(explicit);
    const host = hostPrincipalId(explicit);
    if (host) out.add(host);
  }
  const session = hostSessionReachSeams.currentSession();
  if (session?.principalId) {
    out.add(session.principalId);
    const host = hostPrincipalId(session.principalId);
    if (host) out.add(host);
  }
  return [...out];
}

function policyCovers(policy: string, wanted: HostReachRole): boolean {
  if (wanted === "read")
    return (
      policy === "open" ||
      policy === "items" ||
      policy === "read" ||
      policy === "use"
    );
  return policy === "items" || policy === "use";
}

/**
 * `null` — no Host session bookmarks for this vault; caller keeps local rules.
 * `true` / `false` — Host sessions are in play; answer from mirrored grants
 * (operators always pass).
 */
export async function assertHostSessionReach(
  tomb: string,
  resource: { kind: "vault" } | { kind: "item"; id: string },
  wanted: HostReachRole,
  principalId?: string,
): Promise<void> {
  const allowed = await hostSessionAllows(tomb, resource, wanted, principalId);
  if (allowed === false) throw new Error("host_grant_denied");
}

export async function hostSessionAllows(
  tomb: string,
  resource: { kind: "vault" } | { kind: "item"; id: string },
  wanted: HostReachRole,
  principalId?: string,
): Promise<boolean | null> {
  const bookmarks: HostSessionBookmark[] =
    await hostSessionReachSeams.listHostSessionBookmarks(tomb);
  if (bookmarks.length === 0) return null;

  const role: AccessRole =
    await hostSessionReachSeams.resolveCurrentAccessRole(tomb);
  if (hostSessionReachSeams.canAccess(role, "manage_grants")) return true;

  const principals = principalsToMatch(principalId);
  if (principals.length === 0) return false;

  const shares: LocalShare[] =
    await hostSessionReachSeams.listLocalShares(tomb);
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
