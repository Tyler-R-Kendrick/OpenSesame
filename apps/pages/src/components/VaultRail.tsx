import { foldersForKind } from "@opensesame/app-core/components/vault-rail-model.js";
import type { ItemKindRow } from "@opensesame/app-core/lib/item-kinds.js";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import type { PageTreeNode } from "../lib/page-to-tree.js";
import { PageTreeBranch, PageTreeLeafRow } from "./PageTreeBranch.js";

export type VaultCounts = {
  all: number;
  favorites: number;
  trash: number;
  byKind: Map<string, number>;
  byFolder: Map<string, number>;
};

const TRASH = "/vault?f=trash";

export function VaultRail({
  items,
  folders,
  counts,
  selectedTo,
  kinds,
  showHidden = false,
}: {
  items: VaultItem[];
  folders: Folder[];
  counts: VaultCounts;
  selectedTo: string;
  /** Core kinds plus approved `item-kind` contributions (SURFACE-08). */
  kinds: readonly ItemKindRow[];
  /** List the hidden `trash/` (the rail's "show hidden items"). */
  showHidden?: boolean;
}) {
  const nested = new Set(
    kinds.flatMap(({ id }) =>
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
      {kinds.map(({ id, segment }) => (
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
      {/* A hidden entry: listed while the rail shows hidden items, or while
          it is where you are, so the cursor always has a row to stand on. */}
      {showHidden || selectedTo === TRASH ? (
        <PageTreeLeafRow
          node={{
            ...vaultLeaf("trash", TRASH, counts.trash, true),
            hidden: true,
            kind: "trash",
          }}
          level={2}
          current={selectedTo}
        />
      ) : null}
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
  id: string;
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
