/**
 * Map between sealed-store paths (`Folder/name`) and vault items.
 * Used when bridging the Pages OPFS vault with a git-native store.
 */

import {
  type Folder,
  type SecretItem,
  type VaultItem,
  createItem,
  newId,
} from "./model.js";

export type StorePlainEntry = {
  path: string;
  secret: string;
  trailer: string;
};

export type OsMeta = {
  kind?: string;
  username?: string;
  totp?: string;
  uris?: string[];
  notes?: string;
  connectionRef?: string;
};

/** Split `Email/github.com` into folder + name. */
export function splitStorePath(path: string): {
  folder: string | null;
  name: string;
} {
  const trimmed = path.replace(/^\/+|\/+$/gu, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) {
    return { folder: null, name: trimmed || "untitled" };
  }
  return {
    folder: trimmed.slice(0, idx),
    name: trimmed.slice(idx + 1) || "untitled",
  };
}

export function joinStorePath(folder: string | null, name: string): string {
  const n = name.trim() || "untitled";
  const f = folder?.trim();
  if (!f) return n;
  return `${f}/${n}`;
}

/** Parse an OpenSesame JSON trailer after a blank line, if present. */
export function parseTrailerMeta(trailer: string): OsMeta {
  const text = trailer.trim();
  if (!text.startsWith("{")) return { notes: trailer.trim() || undefined };
  try {
    return JSON.parse(text) as OsMeta;
  } catch {
    return { notes: trailer.trim() || undefined };
  }
}

export function entryToVaultItem(
  entry: StorePlainEntry,
  folderId: string | null = null,
): VaultItem {
  const { name } = splitStorePath(entry.path);
  const meta = parseTrailerMeta(entry.trailer);
  const kind =
    meta.kind === "secret" ? "secret" : meta.kind === "note" ? "note" : "login";

  if (kind === "secret") {
    const item = createItem("secret", name) as SecretItem;
    item.folderId = folderId;
    item.value = entry.secret;
    item.notes = meta.notes ?? "";
    item.connectionRef = meta.connectionRef ?? "";
    return item;
  }
  if (kind === "note") {
    const item = createItem("note", name);
    item.folderId = folderId;
    item.notes = [entry.secret, meta.notes ?? ""].filter(Boolean).join("\n");
    return item;
  }
  const item = createItem("login", name);
  item.folderId = folderId;
  if (item.kind === "login") {
    item.password = entry.secret;
    item.username = meta.username ?? "";
    item.totp = meta.totp ?? "";
    item.notes = meta.notes ?? "";
    item.uris = (meta.uris ?? []).map((uri) => ({
      id: newId(),
      uri,
      match: "domain" as const,
    }));
  }
  return item;
}

export function vaultItemToEntry(
  item: VaultItem,
  folders: Folder[],
): StorePlainEntry {
  const folder = item.folderId
    ? (folders.find((f) => f.id === item.folderId)?.name ?? null)
    : null;
  const path = joinStorePath(folder, item.name);
  const meta: OsMeta = { kind: item.kind, notes: item.notes || undefined };

  let secret = "";
  if (item.kind === "login") {
    secret = item.password;
    meta.username = item.username || undefined;
    meta.totp = item.totp || undefined;
    meta.uris = item.uris.map((u) => u.uri).filter(Boolean);
  } else if (item.kind === "secret") {
    secret = item.value;
    meta.connectionRef = item.connectionRef || undefined;
  } else if (item.kind === "note") {
    secret = item.notes;
    meta.notes = undefined;
  } else if (item.kind === "card") {
    secret = item.number;
    meta.notes =
      [item.cardholder, item.notes].filter(Boolean).join("\n") || undefined;
  } else {
    secret = item.credentialIdB64;
  }

  const trailer = `${JSON.stringify(meta)}\n`;
  return { path, secret, trailer };
}

/** Ensure folders exist for incoming store paths; return folderId by path prefix. */
export function ensureFoldersForEntries(
  entries: StorePlainEntry[],
  existing: Folder[],
): { folders: Folder[]; folderIdByName: Map<string, string> } {
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
): { items: VaultItem[]; folders: Folder[] } {
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

function normalizedPath(path: string): string {
  return path
    .replace(/^\/+|\/+$/gu, "")
    .trim()
    .toLowerCase();
}

/**
 * Merge manifest entries into the vault by store path instead of blind
 * append, so re-importing the same manifest is idempotent rather than a
 * duplicate of every item.
 */
export function planManifestMerge(
  entries: StorePlainEntry[],
  existingItems: VaultItem[],
  existingFolders: Folder[],
): ManifestMergePlan {
  const byPath = new Map<string, VaultItem>();
  for (const item of existingItems) {
    if (item.deletedAt !== null) continue;
    const entry = vaultItemToEntry(item, existingFolders);
    byPath.set(normalizedPath(entry.path), item);
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
    const current = byPath.get(normalizedPath(entry.path));
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
    updates.push({
      ...incoming,
      id: current.id,
      createdAt: current.createdAt,
      folderId: current.folderId,
      favorite: current.favorite,
    });
  }
  return {
    adds,
    updates,
    unchanged,
    // Only materialize folders an added item actually landed in.
    newFolders: newFolders.filter((f) => usedFolderIds.has(f.id)),
  };
}
