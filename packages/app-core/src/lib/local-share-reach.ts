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

export type ShareReachResource =
  | { kind: "vault" }
  | { kind: "folder"; id: string }
  | { kind: "item"; id: string; folderId?: string | null };

async function folderIdOfItem(
  tomb: string,
  itemId: string,
): Promise<string | null> {
  const { vaultStore } = await import("./vault/store.js");
  const snap = vaultStore.getSnapshot();
  if (snap.status !== "unlocked" || snap.tomb !== tomb) return null;
  const item = snap.items.find(
    (row) => row.id === itemId && row.deletedAt === null,
  );
  return item?.folderId ?? null;
}

export const shareReachSeams = {
  resolveCurrentAccessRole,
  canAccess,
  currentSession,
  listLocalShares,
  folderIdOf: folderIdOfItem,
};

function principalsToMatch(explicit?: string): string[] {
  if (explicit) return [explicit];
  const session = shareReachSeams.currentSession();
  return session?.principalId ? [session.principalId] : [];
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

function shareCovers(
  share: LocalShare,
  tomb: string,
  resource: ShareReachResource,
  folderId: string | null,
): boolean {
  if (share.resourceKind === "vault" && share.resourceId === tomb) return true;
  if (resource.kind === "vault") return false;
  if (resource.kind === "folder")
    return share.resourceKind === "folder" && share.resourceId === resource.id;
  if (share.resourceKind === "item" && share.resourceId === resource.id)
    return true;
  return (
    share.resourceKind === "folder" &&
    folderId !== null &&
    share.resourceId === folderId
  );
}

export async function shareAllows(
  tomb: string,
  resource: ShareReachResource,
  wanted: ShareReachRole,
  principalId?: string,
): Promise<boolean> {
  const role: AccessRole = await shareReachSeams.resolveCurrentAccessRole(tomb);
  if (!principalId && shareReachSeams.canAccess(role, "manage_grants"))
    return true;

  const principals = principalsToMatch(principalId);
  if (principals.length === 0) return false;

  const shares: LocalShare[] = await shareReachSeams.listLocalShares(tomb);
  const now = Date.now();
  const live = shares.filter(
    (share) =>
      share.expiresAt > now &&
      principals.includes(share.principalId) &&
      policyCovers(share.policy, wanted),
  );
  let folderId: string | null = null;
  if (resource.kind === "item") {
    folderId =
      resource.folderId !== undefined
        ? resource.folderId
        : live.some((share) => share.resourceKind === "folder")
          ? await shareReachSeams.folderIdOf(tomb, resource.id)
          : null;
  }
  return live.some((share) => shareCovers(share, tomb, resource, folderId));
}

export async function assertShareReach(
  tomb: string,
  resource: ShareReachResource,
  wanted: ShareReachRole,
  principalId?: string,
): Promise<void> {
  const allowed = await shareAllows(tomb, resource, wanted, principalId);
  if (!allowed) throw new Error("share_grant_denied");
}
