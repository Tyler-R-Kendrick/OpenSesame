import {
  concealedValue,
  shareText,
  username,
} from "@opensesame/app-core/sections/vault-section-model.js";
import type { TreeRow, VaultItem } from "@opensesame/vault-core";
import type {
  MenuGroup,
  MenuItem,
} from "../../components/context-menu/menu-model.js";

export type VaultTreeActions = {
  open: (item: VaultItem) => void;
  preview: (item: VaultItem) => void;
  copySecret: (item: VaultItem) => void;
  copyUsername: (item: VaultItem) => void;
  edit: (item: VaultItem) => void;
  trash: (item: VaultItem) => void;
  favorite: (item: VaultItem) => void;
  /** Absent when no capability contributes a way to share a secret. */
  share?: (item: VaultItem) => void;
  create: () => void;
  /** A trashed item's two ways out; absent, the menu offers neither. */
  restore?: (item: VaultItem) => void;
  purge?: (item: VaultItem) => void;
  /** The menu already asked. Runs the delete without arming the path-strip key. */
  commitPurge?: (item: VaultItem) => void;
  /** The listing is the trash directory: no new item from a folder or the pane. */
  inTrash?: boolean;
};

export const PURGE_CONFIRM = "Really delete permanently? This cannot be undone";

function trashedItemMenu(
  item: VaultItem,
  actions: VaultTreeActions,
): MenuGroup[] {
  const { restore, purge } = actions;
  return [
    [
      {
        id: "open",
        label: "Open",
        hint: "Enter",
        run: () => actions.open(item),
      },
    ],
    restore
      ? [
          {
            id: "restore",
            label: "Restore",
            hint: "r",
            run: () => restore(item),
          },
        ]
      : [],
    purge
      ? [
          {
            id: "purge",
            label: "Delete permanently",
            hint: "X",
            danger: true,
            confirm: PURGE_CONFIRM,
            run: () => (actions.commitPurge ?? purge)(item),
          },
        ]
      : [],
  ];
}

/**
 * An item's verbs — the ones its single keys already run, in the order a
 * person reaches for them. An entry the item cannot answer (no username to
 * copy) is shown disabled rather than left to do nothing.
 */
export function vaultItemMenu(
  item: VaultItem,
  actions: VaultTreeActions,
): MenuGroup[] {
  if (item.deletedAt !== null) return trashedItemMenu(item, actions);
  const verb = (
    id: string,
    label: string,
    hint: string,
    run: (item: VaultItem) => void,
    extra: Partial<MenuItem> = {},
  ): MenuItem => ({ id, label, hint, run: () => run(item), ...extra });
  return [
    [
      verb("open", "Open", "Enter", actions.open),
      verb("edit", "Edit", "e", actions.edit),
    ],
    [
      verb("copy-secret", "Copy secret", "y", actions.copySecret, {
        disabled: !concealedValue(item),
      }),
      verb("copy-username", "Copy username", "u", actions.copyUsername, {
        disabled: !username(item),
      }),
    ],
    [
      verb(
        "favorite",
        item.favorite ? "Unfavorite" : "Favorite",
        ".",
        actions.favorite,
      ),
      ...(actions.share && shareText(item)
        ? [verb("share", "Share once", "s", actions.share)]
        : []),
    ],
    [verb("trash", "Trash", "x", actions.trash, { danger: true })],
  ];
}

/** A row's menu: an item's verbs, or a folder's (flip it, add to the vault). */
export function vaultRowMenu(
  row: TreeRow | null,
  actions: VaultTreeActions,
  toggle: (row: TreeRow) => void,
  search: () => void,
): MenuGroup[] {
  const create: MenuItem = {
    id: "new",
    label: "New item",
    hint: "n",
    run: actions.create,
  };
  if (row?.type === "item") return vaultItemMenu(row.item, actions);
  const searchItem: MenuItem = {
    id: "search",
    label: "Search",
    hint: "/",
    run: search,
  };
  if (row?.type === "dir") {
    const folder = [
      {
        id: "toggle",
        label: row.expanded ? "Collapse" : "Expand",
        hint: row.expanded ? "←" : "→",
        run: () => toggle(row),
      },
    ];
    return actions.inTrash ? [folder] : [folder, [create]];
  }
  return actions.inTrash ? [[searchItem]] : [[create, searchItem]];
}
