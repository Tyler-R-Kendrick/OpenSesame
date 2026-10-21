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
import { resolveFilterSlug } from "../../lib/vault-filter-slug.js";

export { resolveFilterSlug };

/** One road out of the sheet: where it goes, what it is called, how many. */
export type Road = {
  key: string;
  to: string;
  label: string;
  count: number;
  active: boolean;
  guideId?: string;
};

export type SharedItemRoadMark = {
  incoming: readonly unknown[];
};

export function buildRoads(
  items: VaultItem[],
  folders: Folder[],
  typeIds: readonly string[],
  filter: string,
  folderId: string | null,
  sharedItems?: ReadonlyMap<string, SharedItemRoadMark>,
): Road[] {
  const live = items.filter((item) => item.deletedAt === null);
  const current = resolveFilterSlug(filter);
  const sharedCount = live.filter(
    (item) => (sharedItems?.get(item.id)?.incoming.length ?? 0) > 0,
  ).length;
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
  if (sharedCount > 0 || filter === "shared" || filter === "owned") {
    roads.push(
      {
        key: "shared",
        to: "/vault?f=shared",
        label: "Shared with me",
        count: sharedCount,
        active: filter === "shared",
      },
      {
        key: "owned",
        to: "/vault?f=owned",
        label: "Owned by me",
        count: live.length - sharedCount,
        active: filter === "owned",
      },
    );
  }
  for (const typeId of typeIds) {
    roads.push({
      key: typeId,
      to: `/vault?f=${typeId}`,
      label: typePlural(typeId),
      count: live.filter((item) => itemTypeId(item) === typeId).length,
      active: current === typeId,
      guideId: typeId === "account" ? "vault.filter.logins" : undefined,
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
