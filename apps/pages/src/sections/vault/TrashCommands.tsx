import type { VaultItem } from "@opensesame/vault-core";
import type { Dispatch, SetStateAction } from "react";
import { useLayoutEffect, useState } from "react";
import { IconRefresh, IconTrash } from "../../components/Icons.js";
import { PURGE_CONFIRM } from "./vault-menu.js";

type TrashStore = {
  restoreItem: (id: string) => unknown;
  purgeItem: (id: string) => unknown;
};

/** Restore, and delete that arms once, for a row that is already in the trash. */
export function trashItemActions(
  store: TrashStore,
  armedId: string | null,
  setArmedId: Dispatch<SetStateAction<string | null>>,
): {
  restore: (item: VaultItem) => void;
  purge: (item: VaultItem) => void;
  commitPurge: (item: VaultItem) => void;
} {
  const trashed = (item: VaultItem) => item.deletedAt !== null;
  return {
    restore: (item) => {
      if (!trashed(item)) return;
      setArmedId(null);
      void store.restoreItem(item.id);
    },
    purge: (item) => {
      if (!trashed(item)) return;
      if (armedId !== item.id) {
        setArmedId(item.id);
        return;
      }
      setArmedId(null);
      void store.purgeItem(item.id);
    },
    commitPurge: (item) => {
      if (!trashed(item)) return;
      setArmedId(null);
      void store.purgeItem(item.id);
    },
  };
}

/**
 * The cursor lives in the tree. These keys read the selected row when they
 * render, and fall back to the first item only while nothing is selected.
 * A selected folder is not an item, so the keys stay disabled.
 */
function cursorItem(
  items: readonly VaultItem[],
  cursorKey: string | null,
): VaultItem | null {
  if (cursorKey === null) return items[0] ?? null;
  return items.find((item) => item.id === cursorKey) ?? null;
}

/** Restore and delete for the trash directory. Icon keys, named and tipped. */
export function TrashCommands({
  items,
  armedId,
  onRestore,
  onPurge,
}: {
  items: readonly VaultItem[];
  armedId: string | null;
  onRestore: (item: VaultItem) => void;
  onPurge: (item: VaultItem) => void;
}) {
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    const selected = document.querySelector<HTMLElement>(
      ".vtree__rows [aria-selected='true']",
    );
    const key = selected?.dataset.vtreeKey ?? null;
    setCursorKey((current) => (current === key ? current : key));
  });
  const item = cursorItem(items, cursorKey);
  const disabled = item === null;
  const armed = item !== null && armedId === item.id;
  return (
    <>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Restore"
        title="Restore (r)"
        disabled={disabled}
        onClick={() => {
          if (item) onRestore(item);
        }}
      >
        <IconRefresh size={15} />
      </button>
      <button
        type="button"
        className={`icon-btn icon-btn--sm icon-btn--danger${armed ? " is-armed" : ""}`}
        aria-label={armed ? PURGE_CONFIRM : "Delete permanently"}
        title={armed ? PURGE_CONFIRM : "Delete permanently (X)"}
        disabled={disabled}
        onClick={() => {
          if (item) onPurge(item);
        }}
      >
        <IconTrash size={15} />
      </button>
    </>
  );
}
