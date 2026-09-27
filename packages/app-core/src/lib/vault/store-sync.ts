/**
 * Map between sealed-store paths (`Folder/name`) and vault items, used when
 * bridging the Pages OPFS vault with a git-native store (ADR 0037 §6).
 *
 * The entry text lives in `store-sync-entry.ts`, one item ↔ one entry in
 * `store-sync-codec.ts`, and which named properties ride where in
 * `store-sync-values.ts`. This module merges a whole manifest into a vault
 * and re-exports the rest, so importers keep one path.
 */
import { type Folder, type VaultItem, newId } from "@opensesame/vault-core";
import { entryToVaultItem, itemToStoreEntry } from "./store-sync-codec.js";
import {
  type StorePlainEntry,
  isWholeItemMeta,
  normalizedStorePath,
  parseTrailerMeta,
  splitStorePath,
} from "./store-sync-entry.js";
import { graftOnto } from "./store-sync-values.js";

export { entryToVaultItem } from "./store-sync-codec.js";
export {
  type OsMeta,
  type StoreCustomField,
  type StorePlainEntry,
  TRAILER_FORMAT,
  extractOtpauthFromTrailer,
  filterEntriesForProject,
  joinStorePath,
  mergeOtpauthIntoTrailer,
  parseTrailerMeta,
  splitStorePath,
  stripOtpauthFromTrailer,
} from "./store-sync-entry.js";

/** Ensure folders exist for incoming store paths; return folderId by path prefix. */
export function ensureFoldersForEntries(
  entries: StorePlainEntry[],
  existing: Folder[],
) {
  const folderIdByName = new Map<string, string>();
  for (const f of existing) {
    folderIdByName.set(f.name.trim().toLowerCase(), f.id);
  }
  const folders = [...existing];
  const now = new Date().toISOString();
  for (const entry of entries) {
    const { folder } = splitStorePath(entry.path);
    if (!folder) continue;
    const key = folder.toLowerCase();
    if (folderIdByName.has(key)) continue;
    const created: Folder = { id: newId(), name: folder, createdAt: now };
    folders.push(created);
    folderIdByName.set(key, created.id);
  }
  return { folders, folderIdByName };
}

export function entriesToVaultItems(
  entries: StorePlainEntry[],
  existingFolders: Folder[],
) {
  const { folders, folderIdByName } = ensureFoldersForEntries(
    entries,
    existingFolders,
  );
  const items = entries.map((entry) => {
    const { folder } = splitStorePath(entry.path);
    const folderId = folder
      ? (folderIdByName.get(folder.toLowerCase()) ?? null)
      : null;
    return entryToVaultItem(entry, folderId);
  });
  return { items, folders };
}

export type ManifestMergePlan = {
  /** Brand-new items to append. */
  adds: VaultItem[];
  /** Existing items with incoming content grafted on (same id, createdAt). */
  updates: VaultItem[];
  /** Entries identical to what the vault already holds. */
  unchanged: number;
  /** Folders the plan needs that do not exist yet. */
  newFolders: Folder[];
};

/**
 * Merge manifest entries into the vault by store path instead of blind
 * append, so re-importing the same manifest is idempotent rather than a
 * duplicate of every item.
 */
function planManifestMergeDefault(
  entries: StorePlainEntry[],
  existingItems: VaultItem[],
  existingFolders: Folder[],
): ManifestMergePlan {
  const byPath = new Map<string, VaultItem>();
  for (const item of existingItems) {
    if (item.deletedAt !== null) continue;
    const entry = vaultItemToEntry(item, existingFolders);
    byPath.set(normalizedStorePath(entry.path), item);
  }

  const { folders, folderIdByName } = ensureFoldersForEntries(
    entries,
    existingFolders,
  );
  const knownFolderIds = new Set(existingFolders.map((f) => f.id));
  const newFolders = folders.filter((f) => !knownFolderIds.has(f.id));
  const usedFolderIds = new Set<string>();

  const adds: VaultItem[] = [];
  const updates: VaultItem[] = [];
  let unchanged = 0;
  for (const entry of entries) {
    const { folder } = splitStorePath(entry.path);
    const folderId = folder
      ? (folderIdByName.get(folder.toLowerCase()) ?? null)
      : null;
    const incoming = entryToVaultItem(entry, folderId);
    const current = byPath.get(normalizedStorePath(entry.path));
    if (!current) {
      if (folderId) usedFolderIds.add(folderId);
      adds.push(incoming);
      continue;
    }
    const currentEntry = vaultItemToEntry(current, folders);
    if (
      currentEntry.secret === entry.secret &&
      currentEntry.trailer.trim() === entry.trailer.trim()
    ) {
      unchanged += 1;
      continue;
    }
    const whole = isWholeItemMeta(parseTrailerMeta(entry.trailer));
    updates.push(graftOnto(current, incoming, whole));
  }
  return {
    adds,
    updates,
    unchanged,
    // Only materialize folders an added item actually landed in.
    newFolders: newFolders.filter((f) => usedFolderIds.has(f.id)),
  };
}

/**
 * Build Host sync blob descriptors from already-sealed ciphertext bytes.
 * Callers must seal locally first — this never accepts plaintext secrets.
 */
export function sealedBytesToSyncBlobs(
  items: Array<{ id: string; epoch: number; ciphertext: Uint8Array }>,
): Array<{ id: string; epoch: number; ciphertextB64: string }> {
  return items.map((item) => {
    if (!item.ciphertext.length) {
      throw new Error("refusing empty ciphertext sync blob");
    }
    let binary = "";
    for (const byte of item.ciphertext) {
      binary += String.fromCharCode(byte);
    }
    return {
      id: item.id,
      epoch: item.epoch,
      ciphertextB64: btoa(binary),
    };
  });
}

export const storeSyncSeams = {
  vaultItemToEntry: itemToStoreEntry,
  planManifestMerge: planManifestMergeDefault,
};

export function vaultItemToEntry(
  item: VaultItem,
  folders: Folder[],
): StorePlainEntry {
  return storeSyncSeams.vaultItemToEntry(item, folders);
}

export function planManifestMerge(
  entries: StorePlainEntry[],
  existingItems: VaultItem[],
  existingFolders: Folder[],
): ManifestMergePlan {
  return storeSyncSeams.planManifestMerge(
    entries,
    existingItems,
    existingFolders,
  );
}
