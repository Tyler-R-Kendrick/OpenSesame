/**
 * The vault listing as rows (a headless view-model, ADR 0133): folders in
 * order with their items beneath, root items last, a search that keeps a
 * matching directory whole and otherwise only matching children. The Pages
 * tree renders these rows; a CLI or a native list can list them the same way.
 */
import type { Folder, VaultItem } from "../../lib/vault/model.js";
import { itemExtension, pathSegment } from "../../lib/vault/paths.js";

export type DirRow = {
  type: "dir";
  key: string;
  path: string;
  name: string;
  count: number;
  expanded: boolean;
};

export type ItemRow = {
  type: "item";
  key: string;
  path: string;
  name: string;
  ext: string;
  child: boolean;
  item: VaultItem;
};

export type TreeRow = DirRow | ItemRow;

export function itemMatches(item: VaultItem, query: string): boolean {
  return `${pathSegment(item.name)}${itemExtension(item)}`
    .toLowerCase()
    .includes(query);
}

/** Items grouped under the folders that exist; the rest sit at the root. */
function groupByFolder(
  items: VaultItem[],
  folders: Folder[],
): { grouped: Map<string, VaultItem[]>; rootItems: VaultItem[] } {
  const grouped = new Map<string, VaultItem[]>();
  const rootItems: VaultItem[] = [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  for (const item of items) {
    if (!item.folderId || !folderIds.has(item.folderId)) {
      rootItems.push(item);
      continue;
    }
    const bucket = grouped.get(item.folderId);
    if (bucket) bucket.push(item);
    else grouped.set(item.folderId, [item]);
  }
  return { grouped, rootItems };
}

/**
 * Two folders may share a display name; their paths must not, or their
 * collapse state (persisted by path) and the status line would couple.
 */
function distinctFolderNames(folders: Folder[]): string[] {
  const seen = new Map<string, number>();
  return folders.map((folder) => {
    const base = pathSegment(folder.name);
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    return nth > 1 ? `${base} (${nth})` : base;
  });
}

function itemRow(item: VaultItem, prefix: string): ItemRow {
  return {
    type: "item",
    key: item.id,
    path: `${prefix}${pathSegment(item.name)}${itemExtension(item)}`,
    name: pathSegment(item.name),
    ext: itemExtension(item),
    child: prefix !== "",
    item,
  };
}

/** One folder's row, and its items when it is open. */
function folderRows(
  folder: Folder,
  name: string,
  bucket: VaultItem[],
  collapsed: ReadonlySet<string>,
  query: string,
): TreeRow[] {
  // A query that names the folder keeps the whole directory; otherwise the
  // folder survives only through its matching children.
  const dirHit = query !== "" && name.toLowerCase().includes(query);
  const children =
    dirHit || !query
      ? bucket
      : bucket.filter((item) => itemMatches(item, query));
  if (query && children.length === 0 && !dirHit) return [];
  const path = `${name}/`;
  // A search opens every directory it matched into; outside a search the
  // reader's own collapse choices hold.
  const expanded = query !== "" || !collapsed.has(path);
  const dir: DirRow = {
    type: "dir",
    key: `dir_${folder.id}`,
    path,
    name,
    count: children.length,
    expanded,
  };
  return expanded
    ? [dir, ...children.map((item) => itemRow(item, path))]
    : [dir];
}

export function buildRows(
  items: VaultItem[],
  folders: Folder[],
  collapsed: ReadonlySet<string>,
  query: string,
): TreeRow[] {
  const { grouped, rootItems } = groupByFolder(items, folders);
  const names = distinctFolderNames(folders);
  const rows = folders.flatMap((folder, index) =>
    folderRows(
      folder,
      names[index] ?? pathSegment(folder.name),
      grouped.get(folder.id) ?? [],
      collapsed,
      query,
    ),
  );
  for (const item of rootItems) {
    if (!query || itemMatches(item, query)) rows.push(itemRow(item, ""));
  }
  return rows;
}
