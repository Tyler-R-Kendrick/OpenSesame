/**
 * What hiding items reads and writes in the running app (ADR 0171): the open
 * vault, the places that could hold a copy this device would hand back, and
 * the places that keep a trace of an item beside it. Tests replace the lot
 * through `travelItemSeams`.
 */

import { lockManager } from "../../ports.js";
import { forgetActivityAbout } from "../activity-log.js";
import { listLocalBackupTargets } from "../backup-target-local.js";
import { holdsAnyHistoryEntry } from "../history-backup-idb.js";
import { loadHistorySelections } from "../history-backups.js";
import { listLocalShares } from "../local-share-grants.js";
import { listVaultSessions } from "../local-vault-sessions.js";
import {
  dropCachedCiphertextSnapshot,
  listOfflineMutations,
} from "../vault/offline-backup.js";
import { forgetRetiredPasswords } from "../vault/password-history.js";
import { vaultStore } from "../vault/store.js";
import { VfsError, readFile } from "../vfs.js";
import { duressActive } from "./duress-gate.js";
import type { ItemsCopy, ItemsDeps } from "./items-depart.js";
import { originTravelStorage } from "./storage.js";

/** The personal vault's offline records are kept under no project id. */
function projectIdOf(tomb: string): string | null {
  return tomb === "personal" ? null : tomb;
}

/**
 * Where a vault keeps its drive pairing (`tailnet-sync/config.ts`; a test holds
 * the two equal). Read by path, not through that module: the drive's code is
 * an optional capability and the entry may not reach it (ADR 0130).
 */
export const DRIVE_PAIRING_PATH = "config/tailnet-drive";

async function pairedWithDrive(tomb: string): Promise<boolean> {
  try {
    await readFile(tomb, DRIVE_PAIRING_PATH);
    return true;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return false;
    throw error;
  }
}

async function holdsHistorySnapshot(): Promise<boolean> {
  const bound = loadHistorySelections().some((row) =>
    Boolean(row.remote?.trim() || row.connectionId?.trim()),
  );
  return bound || (await holdsAnyHistoryEntry());
}

async function copiesInPlay(tomb: string): Promise<readonly ItemsCopy[]> {
  const copies: ItemsCopy[] = [];
  if (listLocalBackupTargets().some((target) => target.enabled)) {
    copies.push("backup_target");
  }
  if (await holdsHistorySnapshot()) copies.push("history_snapshot");
  if (await pairedWithDrive(tomb)) copies.push("paired_drive");
  const project = projectIdOf(tomb);
  if (listOfflineMutations().some((entry) => entry.projectId === project)) {
    copies.push("offline_queue");
  }
  return copies;
}

async function sharedItems(tomb: string): Promise<ReadonlySet<string>> {
  const shares = await listLocalShares(tomb);
  const sessions = await listVaultSessions(tomb);
  const ids = new Set<string>();
  const folderIds = new Set<string>();
  for (const share of shares) {
    if (share.resourceKind === "item") ids.add(share.resourceId);
    if (share.resourceKind === "folder") folderIds.add(share.resourceId);
  }
  for (const session of sessions) {
    for (const grant of session.grants) {
      if (grant.resourceKind === "item") ids.add(grant.resourceId);
      if (grant.resourceKind === "folder") folderIds.add(grant.resourceId);
    }
  }
  if (folderIds.size > 0) {
    const snap = vaultStore.getSnapshot();
    if (snap.status === "unlocked" && snap.tomb === tomb) {
      for (const item of snap.items) {
        if (
          item.deletedAt === null &&
          item.folderId !== null &&
          folderIds.has(item.folderId)
        )
          ids.add(item.id);
      }
    }
  }
  return ids;
}

type TravelItemSeams = { deps: ItemsDeps };

export const travelItemSeams: TravelItemSeams = {
  deps: {
    storage: originTravelStorage,
    duressActive,
    ownerPresent: () => {
      const snapshot = vaultStore.getSnapshot();
      return snapshot.status === "unlocked" && !snapshot.guest;
    },
    exclusive: async (work) => {
      const locks = lockManager();
      return locks ? locks.request("opensesame.travel", work) : work();
    },
    now: () => new Date(),
    vault: () => {
      const snapshot = vaultStore.getSnapshot();
      if (
        snapshot.status !== "unlocked" ||
        snapshot.guest ||
        snapshot.header === null
      ) {
        return null;
      }
      return {
        tomb: snapshot.tomb,
        createdAt: snapshot.header.createdAt,
        // As sealed: an account without its methods, and its credentials beside it.
        items: snapshot.rawItems ?? snapshot.items,
        folders: snapshot.folders,
      };
    },
    sharedItems,
    copiesInPlay,
    withdraw: (plan) => vaultStore.withdrawItems(plan),
    restore: (back) => vaultStore.restoreWithdrawn(back),
    purge: {
      activity: forgetActivityAbout,
      passwords: forgetRetiredPasswords,
      offlineCache: (tomb) => dropCachedCiphertextSnapshot(projectIdOf(tomb)),
    },
  },
};
