import type { Folder, VaultBody, VaultItem } from "./model.js";

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
  if (!name.includes("/")) return { name, folderId, folder: selected };
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
  const folderName = parts.join("/");
  const folder = folderName
    ? (folders.find((entry) => entry.name === folderName) ?? {
        id: crypto.randomUUID(),
        name: folderName,
        createdAt: new Date().toISOString(),
      })
    : undefined;
  return { name: shortName, folderId: folder?.id ?? null, folder };
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

/** Item and staged folder commit together inside VaultStore's sealed mutation. */
export function writeItem(body: VaultBody, item: VaultItem, folder?: Folder) {
  let folderId = item.folderId;
  if (folder) {
    if (folder.id !== folderId)
      throw new Error("Item folder does not match its path.");
    const existing = body.folders.find(
      (entry) => entry.id === folder.id || entry.name === folder.name,
    );
    if (!existing) body.folders = [...body.folders, folder];
    folderId = existing?.id ?? folder.id;
  }
  const next = { ...item, folderId, updatedAt: new Date().toISOString() };
  const index = body.items.findIndex((candidate) => candidate.id === item.id);
  body.items =
    index === -1
      ? [...body.items, next]
      : body.items.map((entry, i) => (i === index ? next : entry));
}
