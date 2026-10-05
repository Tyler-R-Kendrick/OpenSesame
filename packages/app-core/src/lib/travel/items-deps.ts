/**
 * What hiding items reads and writes in the running app (ADR 0170): the open
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
import { readDriveConfig } from "../tailnet-sync/config.js";
import {
  dropCachedCiphertextSnapshot,
  listOfflineMutations,
} from "../vault/offline-backup.js";
import { forgetRetiredPasswords } from "../vault/password-history.js";
import { vaultStore } from "../vault/store.js";
import { duressActive } from "./duress-gate.js";
import type { ItemsCopy, ItemsDeps } from "./items-depart.js";
import { originTravelStorage } from "./storage.js";

/** The personal vault's offline records are kept under no project id. */
function projectIdOf(tomb: string): string | null {
  return tomb === "personal" ? null : tomb;
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
  if ((await readDriveConfig(tomb)) !== null) copies.push("paired_drive");
  const project = projectIdOf(tomb);
  if (listOfflineMutations().some((entry) => entry.projectId === project)) {
    copies.push("offline_queue");
  }
  return copies;
}

async function sharedItems(tomb: string): Promise<ReadonlySet<string>> {
  const shares = await listLocalShares(tomb);
  const sessions = await listVaultSessions(tomb);
  return new Set([
    ...shares
      .filter((share) => share.resourceKind === "item")
      .map((share) => share.resourceId),
    ...sessions.flatMap((session) =>
      session.grants
        .filter((grant) => grant.resourceKind === "item")
        .map((grant) => grant.resourceId),
    ),
  ]);
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
        items: snapshot.items,
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
