import type { Folder, VaultItem } from "./model.js";

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
