import { itemTypeId, typeExtension } from "./item-types.js";
import type { Folder, LegacyItemKind, VaultItem } from "./model.js";

/** Items are files; the type is the extension. One vocabulary for the tree,
    the editor's type selector, and search.

    Every extension — these included — is declared by the item type's own
    definition (ADR 0087 §1); this table is the fallback for a caller holding
    a legacy kind and no item. */
export const KIND_EXT = {
  login: ".login",
  passkey: ".passkey",
  card: ".card",
  secret: ".secret",
  drop: ".drop",
  note: ".note",
  certificate: ".cert",
} satisfies Record<LegacyItemKind, string>;

/** The extension for any item, plugin-defined types included. */
export function itemExtension(item: VaultItem): string {
  return typeExtension(itemTypeId(item));
}

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
