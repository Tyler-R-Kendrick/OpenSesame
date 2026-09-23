/**
 * View-model logic for `VaultRail` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import {
  type Folder,
  type VaultItem,
  itemTypeId,
} from "@opensesame/vault-core";
import { type ItemKindRow, itemKindsSnapshot } from "../lib/item-kinds.js";

export function foldersForKind(
  kind: string,
  items: VaultItem[],
  folders: Folder[],
) {
  const ids = new Set(
    items
      .filter(
        (item) =>
          item.deletedAt === null && itemTypeId(item) === kind && item.folderId,
      )
      .map((item) => item.folderId),
  );
  return folders.filter((folder) => ids.has(folder.id));
}

export function uniqueFolderKind(
  items: VaultItem[],
  folderId: string,
  rows: readonly ItemKindRow[] = itemKindsSnapshot(),
): string | null {
  const kinds = new Set(
    items
      .filter((item) => item.deletedAt === null && item.folderId === folderId)
      .map(itemTypeId),
  );
  if (kinds.size !== 1) return null;
  const kind = [...kinds][0];
  return kind && rows.some((entry) => entry.id === kind) ? kind : null;
}
