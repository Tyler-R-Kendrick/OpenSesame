/**
 * View-model logic for `VaultFilterMenu` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import {
  type Folder,
  type VaultItem,
  itemTypeId,
  typePlural,
} from "@opensesame/vault-core";

/** One road out of the sheet: where it goes, what it is called, how many. */
export type Road = {
  key: string;
  to: string;
  label: string;
  count: number;
  active: boolean;
  guideId?: string;
};

export function buildRoads(
  items: VaultItem[],
  folders: Folder[],
  typeIds: readonly string[],
  filter: string,
  folderId: string | null,
): Road[] {
  const live = items.filter((item) => item.deletedAt === null);
  const roads: Road[] = [
    {
      key: "all",
      to: "/vault",
      label: "All items",
      count: live.length,
      active: filter === "all" && !folderId,
    },
    {
      key: "favorites",
      to: "/vault?f=favorites",
      label: "Favorites",
      count: live.filter((item) => item.favorite).length,
      active: filter === "favorites",
      guideId: "vault.filter.favorites",
    },
  ];
  for (const typeId of typeIds) {
    roads.push({
      key: typeId,
      to: `/vault?f=${typeId}`,
      label: typePlural(typeId),
      count: live.filter((item) => itemTypeId(item) === typeId).length,
      active: filter === typeId,
      guideId: typeId === "login" ? "vault.filter.logins" : undefined,
    });
  }
  for (const folder of folders) {
    roads.push({
      key: `folder:${folder.id}`,
      to: `/vault?folder=${encodeURIComponent(folder.id)}`,
      label: folder.name,
      count: live.filter((item) => item.folderId === folder.id).length,
      active: folderId === folder.id,
    });
  }
  roads.push({
    key: "trash",
    to: "/vault?f=trash",
    label: "Trash",
    count: items.filter((item) => item.deletedAt !== null).length,
    active: filter === "trash",
  });
  return roads;
}
