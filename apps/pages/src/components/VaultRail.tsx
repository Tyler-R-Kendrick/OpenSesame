import type { PageTreeNode } from "../lib/page-to-tree.js";
import type { Folder, ItemKind, VaultItem } from "../lib/vault/model.js";
import { PageTreeBranch, PageTreeLeafRow } from "./PageTreeBranch.js";
import { KIND_SEGMENTS } from "./RailRows.js";

export type VaultCounts = {
  all: number;
  favorites: number;
  trash: number;
  byKind: Map<ItemKind, number>;
  byFolder: Map<string, number>;
};

export function foldersForKind(
  kind: ItemKind,
  items: VaultItem[],
  folders: Folder[],
) {
  const ids = new Set(
    items
      .filter(
        (item) =>
          item.deletedAt === null && item.kind === kind && item.folderId,
      )
      .map((item) => item.folderId),
  );
  return folders.filter((folder) => ids.has(folder.id));
}

export function uniqueFolderKind(
  items: VaultItem[],
  folderId: string,
): ItemKind | null {
  const kinds = new Set(
    items
      .filter((item) => item.deletedAt === null && item.folderId === folderId)
      .map((item) => item.kind),
  );
  if (kinds.size !== 1) return null;
  const kind = [...kinds][0];
  return kind && KIND_SEGMENTS.some((entry) => entry.id === kind) ? kind : null;
}

export function VaultRail({
  items,
  folders,
  counts,
  selectedTo,
}: {
  items: VaultItem[];
  folders: Folder[];
  counts: VaultCounts;
  selectedTo: string;
}) {
  const nested = new Set(
    KIND_SEGMENTS.flatMap(({ id }) =>
      foldersForKind(id, items, folders).map((folder) => folder.id),
    ),
  );
  return (
    <div className="railtree__kids">
      <PageTreeLeafRow
        node={vaultLeaf("all", "/vault", counts.all)}
        level={2}
        current={selectedTo}
      />
      <PageTreeLeafRow
        node={vaultLeaf("favorites", "/vault?f=favorites", counts.favorites)}
        level={2}
        current={selectedTo}
      />
      {KIND_SEGMENTS.map(({ id, segment }) => (
        <KindFilter
          key={id}
          id={id}
          segment={segment}
          count={counts.byKind.get(id) ?? 0}
          folders={foldersForKind(id, items, folders)}
          items={items}
          selectedTo={selectedTo}
        />
      ))}
      <PageTreeLeafRow
        node={vaultLeaf("trash", "/vault?f=trash", counts.trash)}
        level={2}
        current={selectedTo}
      />
      {folders
        .filter((folder) => !nested.has(folder.id))
        .map((folder) => (
          <PageTreeLeafRow
            key={folder.id}
            node={vaultLeaf(
              folder.name,
              `/vault?folder=${encodeURIComponent(folder.id)}`,
              counts.byFolder.get(folder.id) ?? 0,
              true,
              folder.id,
            )}
            level={2}
            current={selectedTo}
          />
        ))}
    </div>
  );
}

function vaultLeaf(
  label: string,
  href: string,
  count: number,
  dir = false,
  id = label,
): PageTreeNode {
  return { id, label, href, children: [], branch: false, count, dir };
}

function KindFilter({
  id,
  segment,
  count,
  folders,
  items,
  selectedTo,
}: {
  id: ItemKind;
  segment: string;
  count: number;
  folders: Folder[];
  items: VaultItem[];
  selectedTo: string;
}) {
  if (folders.length === 0) {
    return (
      <PageTreeLeafRow
        node={vaultLeaf(segment, `/vault?f=${id}`, count, false, id)}
        level={2}
        current={selectedTo}
      />
    );
  }
  return (
    <PageTreeBranch
      node={{
        id,
        label: segment,
        href: `/vault?f=${id}`,
        branch: true,
        count,
        children: folders.map((folder) => ({
          id: folder.id,
          label: folder.name,
          href: `/vault?f=${id}&folder=${encodeURIComponent(folder.id)}`,
          children: [],
          branch: false,
          dir: true,
          count: items.filter(
            (item) =>
              item.deletedAt === null &&
              item.kind === id &&
              item.folderId === folder.id,
          ).length,
        })),
      }}
      level={2}
      current={selectedTo}
    />
  );
}
