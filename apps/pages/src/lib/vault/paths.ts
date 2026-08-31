import type { Folder, ItemKind, VaultItem } from "./model.js";

/** Items are files; the kind is the extension. One vocabulary for the tree,
    the editor's type selector, and search. */
export const KIND_EXT = {
  login: ".login",
  passkey: ".passkey",
  card: ".card",
  secret: ".secret",
  drop: ".drop",
  note: ".note",
  certificate: ".cert",
} satisfies Record<ItemKind, string>;

export function pathSegment(name: string): string {
  return (name.trim() || "Untitled").replaceAll("/", "／");
}

export function itemPath(item: VaultItem, folders: Folder[]): string {
  const folder = folders.find((candidate) => candidate.id === item.folderId);
  return folder
    ? `${pathSegment(folder.name)}/${pathSegment(item.name)}`
    : pathSegment(item.name);
}

export function tombPath(tomb: string, path: string | null): string {
  return `${tomb}:/${path ?? ""}`;
}
