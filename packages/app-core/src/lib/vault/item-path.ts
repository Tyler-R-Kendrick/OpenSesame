import {
  type Folder,
  type VaultBody,
  type VaultItem,
  bindRefusalMessage,
  normalizeItems,
  saveCredential,
  splitAccount,
} from "@opensesame/vault-core";
import { FIELD_LIMITS, isFolderPath } from "./field-limits.js";

export function itemCreatePath(
  kind: string | undefined,
  folderId: string | null,
) {
  const route = kind ? `/vault/new/${encodeURIComponent(kind)}` : "/vault/new";
  return folderId ? `${route}?folder=${encodeURIComponent(folderId)}` : route;
}

/** Slash paths are relative to the chosen folder; a leading slash means root. */
export function resolveItemPath(
  name: string,
  folderId: string | null,
  folders: Folder[],
) {
  const selected = folders.find((folder) => folder.id === folderId);
  if (folderId && !selected) throw new Error("Choose an available folder.");
  if (!name.includes("/")) {
    assertNameLength(name);
    return { name, folderId, folder: selected };
  }
  const input = name.trim();
  if (
    input.endsWith("/") ||
    input.includes("\\") ||
    [...input].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(
      "End the path with an item name, not a slash or control character.",
    );
  }
  const parts = pathSegments(input, selected?.name);
  const shortName = parts.pop() ?? "";
  assertNameLength(shortName);
  const folderName = parts.join("/");
  const folder = folderName
    ? (existing(folders, folderName) ?? made(folderName))
    : undefined;
  return { name: shortName, folderId: folder?.id ?? null, folder };
}

function assertNameLength(name: string) {
  if (name.length > FIELD_LIMITS.name)
    throw new Error(`A name can be at most ${FIELD_LIMITS.name} characters.`);
}

const existing = (folders: Folder[], name: string) =>
  folders.find((entry) => entry.name === name);

/** A folder a path names that the vault does not have yet. */
function made(name: string): Folder {
  if (!isFolderPath(name))
    throw new Error(
      `A folder path can be at most ${FIELD_LIMITS.folder} characters, and each folder name ${FIELD_LIMITS.name}.`,
    );
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
  };
}

function pathSegments(input: string, base?: string) {
  const parts = input.startsWith("/") ? [] : (base?.split("/") ?? []);
  for (const part of input.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length)
        throw new Error("The path cannot go above the vault root.");
      parts.pop();
    } else parts.push(part);
  }
  const leaf = input.split("/").at(-1);
  if (!parts.length || leaf === "." || leaf === "..")
    throw new Error("End the path with an item name.");
  return parts;
}

/**
 * When a write happened: now, or a millisecond past the item's last time when
 * the two fall in the same one, so a write is always later than what it
 * replaced, whatever else in the body it changed (a credential, ADR 0179).
 */
function writtenAt(prior: VaultItem | undefined): string {
  const wall = new Date().toISOString();
  if (prior === undefined || prior.updatedAt < wall) return wall;
  return new Date(Date.parse(prior.updatedAt) + 1).toISOString();
}

/** Item and staged folder commit together inside VaultStore's sealed mutation. */
export function writeItem(body: VaultBody, item: VaultItem, folder?: Folder) {
  let folderId = item.folderId;
  if (folder) {
    if (folder.id !== folderId)
      throw new Error("Item folder does not match its path.");
    const existing =
      body.folders.find((entry) => entry.id === folder.id) ??
      body.folders.find((entry) => entry.name === folder.name);
    if (!existing) body.folders = [...body.folders, folder];
    folderId = existing?.id ?? folder.id;
  }
  const [account = item] = normalizeItems([item]);
  const at = writtenAt(body.items.find((entry) => entry.id === item.id));
  const next = { ...account, folderId, updatedAt: at };
  // An account is written with the methods it now has: each is a credential of
  // its own and one it dropped goes to the trash (ADR 0179).
  if (next.kind === "account") {
    body.items = splitAccount(body.items, next, at);
    return;
  }
  // A credential written on its own is bound, moved or released (ADR 0179).
  if (next.kind === "credential") {
    const saved = saveCredential(body.items, next, at);
    if (!saved.ok) throw new Error(bindRefusalMessage(saved.refusal));
    body.items = saved.items;
    return;
  }
  const index = body.items.findIndex((candidate) => candidate.id === item.id);
  body.items =
    index === -1
      ? [...body.items, next]
      : body.items.map((entry, i) => (i === index ? next : entry));
}
