/**
 * Map between sealed-store paths (`Folder/name`) and vault items.
 * Used when bridging the Pages OPFS vault with a git-native store.
 */

import {
  createItem,
  newId,
  type Folder,
  type SecretItem,
  type VaultItem,
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

/** First otpauth:// line in a pass-otp style trailer, if any. */
export function extractOtpauthFromTrailer(trailer: string): string | null {
  for (const line of trailer.split(/\r?\n/u)) {
    const t = line.trim();
    if (/^otpauth:\/\//iu.test(t)) return t;
  }
  return null;
}

/** Drop otpauth lines from trailer text. */
export function stripOtpauthFromTrailer(trailer: string): string {
  return trailer
    .split(/\r?\n/u)
    .filter((line) => !/^otpauth:\/\//iu.test(line.trim()))
    .join("\n");
}

/** Ensure trailer contains exactly one otpauth line when totp is set. */
export function mergeOtpauthIntoTrailer(
  trailer: string,
  otpauth: string | null | undefined,
): string {
  const without = stripOtpauthFromTrailer(trailer).replace(/\n+$/u, "");
  if (!otpauth?.trim()) {
    return without ? `${without}\n` : "";
  }
  const uri = otpauth.trim();
  if (!without) return `${uri}\n`;
  return `${without}\n${uri}\n`;
}

/** Split `Email/github.com` into folder + name. */
export function splitStorePath(path: string): { folder: string | null; name: string } {
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
  const withoutOtp = stripOtpauthFromTrailer(trailer);
  const text = withoutOtp.trim();
  if (!text.startsWith("{")) return { notes: text || undefined };
  try {
    return JSON.parse(text) as OsMeta;
  } catch {
    return { notes: text || undefined };
  }
}

export function entryToVaultItem(
  entry: StorePlainEntry,
  folderId: string | null = null,
): VaultItem {
  const { name } = splitStorePath(entry.path);
  const meta = parseTrailerMeta(entry.trailer);
  const otpauth = extractOtpauthFromTrailer(entry.trailer);
  const kind = meta.kind === "secret" ? "secret" : meta.kind === "note" ? "note" : "login";

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
    item.totp = otpauth ?? meta.totp ?? "";
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
  let otpauth: string | null = null;
  if (item.kind === "login") {
    secret = item.password;
    meta.username = item.username || undefined;
    if (item.totp) {
      if (/^otpauth:\/\//iu.test(item.totp.trim())) {
        otpauth = item.totp.trim();
      } else {
        meta.totp = item.totp;
      }
    }
    meta.uris = item.uris.map((u) => u.uri).filter(Boolean);
  } else if (item.kind === "secret") {
    secret = item.value;
    meta.connectionRef = item.connectionRef || undefined;
  } else if (item.kind === "note") {
    secret = item.notes;
    delete meta.notes;
  } else if (item.kind === "card") {
    secret = item.number;
    meta.notes = [item.cardholder, item.notes].filter(Boolean).join("\n") || undefined;
  } else {
    secret = item.credentialIdB64;
  }

  const jsonTrailer = `${JSON.stringify(meta)}\n`;
  const trailer = mergeOtpauthIntoTrailer(jsonTrailer, otpauth);
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
  const { folders, folderIdByName } = ensureFoldersForEntries(entries, existingFolders);
  const items = entries.map((entry) => {
    const { folder } = splitStorePath(entry.path);
    const folderId = folder ? (folderIdByName.get(folder.toLowerCase()) ?? null) : null;
    return entryToVaultItem(entry, folderId);
  });
  return { items, folders };
}
