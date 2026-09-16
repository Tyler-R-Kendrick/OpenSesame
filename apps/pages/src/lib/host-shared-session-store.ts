/**
 * Bookmarks for Host shared sessions opened from this vault, plus local
 * share mirrors so Access › Grants and vault reach honor Host grants on
 * the device (ADR 0079 + ADR 0090 offline plane).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { hostSessionKey, hostVaultIdForTomb } from "./host-ids.js";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import {
  createLocalShare,
  revokeSharesForSession,
} from "./local-share-grants.js";
import type { SessionGrant, SessionRole } from "./shared-sessions.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/host-shared-sessions";
const MAX_BYTES = 128_000;
const MAX_BOOKMARKS = 32;

export type HostSessionBookmark = {
  sessionId: string;
  displayName: string;
  visibility: "private" | "public";
  vaultId: string;
  openedAt: number;
};

function text(value: BoundaryValue, max: number): value is string {
  return isString(value) && value.length > 0 && value.length <= max;
}

function isBookmark(value: BoundaryValue): value is HostSessionBookmark {
  return (
    isJsonObject(value) &&
    text(value.sessionId, 80) &&
    text(value.displayName, 120) &&
    (value.visibility === "private" || value.visibility === "public") &&
    text(value.vaultId, 80) &&
    isNumber(value.openedAt) &&
    Number.isSafeInteger(value.openedAt)
  );
}

async function readAll(tomb: string): Promise<HostSessionBookmark[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDirectoryError("Host session storage exceeds its limit.");
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      value.version !== 1 ||
      !Array.isArray(value.sessions) ||
      value.sessions.length > MAX_BOOKMARKS ||
      !value.sessions.every(isBookmark)
    )
      throw new LocalDirectoryError("Host session storage is invalid.");
    return value.sessions;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

async function writeAll(
  tomb: string,
  sessions: HostSessionBookmark[],
): Promise<void> {
  await writeFile(
    tomb,
    PATH,
    new TextEncoder().encode(JSON.stringify({ version: 1, sessions }, null, 2)),
  );
}

export async function listHostSessionBookmarks(
  tomb: string,
): Promise<HostSessionBookmark[]> {
  return readAll(tomb);
}

export async function rememberHostSession(
  tomb: string,
  input: {
    sessionId: string;
    displayName: string;
    visibility: "private" | "public";
  },
): Promise<HostSessionBookmark[]> {
  const vaultId = await hostVaultIdForTomb(tomb);
  const bookmark: HostSessionBookmark = {
    sessionId: input.sessionId,
    displayName: input.displayName.trim(),
    visibility: input.visibility,
    vaultId,
    openedAt: Date.now(),
  };
  const next = [
    bookmark,
    ...(await readAll(tomb)).filter(
      (row) => row.sessionId !== bookmark.sessionId,
    ),
  ].slice(0, MAX_BOOKMARKS);
  await writeAll(tomb, next);
  return next;
}

export async function forgetHostSession(
  tomb: string,
  sessionId: string,
): Promise<HostSessionBookmark[]> {
  const key = hostSessionKey(sessionId) ?? sessionId;
  await revokeSharesForSession(tomb, key, { bypassAccessCheck: true });
  const next = (await readAll(tomb)).filter(
    (row) => row.sessionId !== sessionId,
  );
  await writeAll(tomb, next);
  return next;
}

function snapDurationSeconds(expiresAt: string): number {
  const ms = Date.parse(expiresAt) - Date.now();
  const seconds = Math.ceil(ms / 1000);
  if (!Number.isFinite(seconds)) return 3600;
  return Math.min(7 * 86400, Math.max(60, seconds));
}

function localPolicy(role: SessionRole, kind: "vault" | "item"): string {
  if (kind === "vault") return role === "write" ? "items" : "open";
  return role === "write" ? "use" : "read";
}

/** Mirror a Host grant into the local share ledger for this tomb. */
export async function mirrorHostGrant(
  tomb: string,
  sessionId: string,
  grant: SessionGrant,
  labels: { vaultLabel: string; itemLabels: Record<string, string> },
): Promise<void> {
  const key = hostSessionKey(sessionId);
  if (!key) return;
  const durationSeconds = snapDurationSeconds(grant.expiresAt);
  if (grant.scope.kind === "collection") {
    await createLocalShare(
      tomb,
      {
        principalId: grant.principalId,
        resourceKind: "vault",
        resourceId: tomb,
        resourceLabel: labels.vaultLabel,
        policy: localPolicy(grant.role, "vault"),
        durationSeconds,
        sessionId: key,
      },
      { bypassAccessCheck: true, freeDuration: true },
    );
    return;
  }
  for (const itemHostId of grant.scope.items) {
    const localId = itemHostId.replace(/^item:/i, "");
    await createLocalShare(
      tomb,
      {
        principalId: grant.principalId,
        resourceKind: "item",
        resourceId: localId,
        resourceLabel: labels.itemLabels[localId] ?? localId.slice(0, 8),
        policy: localPolicy(grant.role, "item"),
        durationSeconds,
        sessionId: key,
      },
      { bypassAccessCheck: true, freeDuration: true },
    );
  }
}

export async function revokeMirroredHostGrant(
  tomb: string,
  sessionId: string,
  principalId?: string,
): Promise<void> {
  const key = hostSessionKey(sessionId);
  if (!key) return;
  if (!principalId) {
    await revokeSharesForSession(tomb, key, { bypassAccessCheck: true });
    return;
  }
  const { listLocalShares, revokeLocalShare } = await import(
    "./local-share-grants.js"
  );
  const shares = await listLocalShares(tomb);
  for (const share of shares) {
    if (share.sessionId === key && share.principalId === principalId)
      await revokeLocalShare(tomb, share.id, { bypassAccessCheck: true });
  }
}
