import { isCommandSection } from "@opensesame/app-core/lib/command-bar/types.js";
import { username } from "@opensesame/app-core/sections/vault-section-model.js";
import type { DirRow, TreeRow, VaultItem } from "@opensesame/vault-core";
import type {
  MenuGroup,
  MenuItem,
} from "../../components/context-menu/menu-model.js";
import { canCopySecret } from "./account-copy.js";
import { credentialChoices } from "./account-credentials.js";

export type VaultTreeActions = {
  open: (item: VaultItem) => void;
  preview: (item: VaultItem) => void;
  copySecret: (item: VaultItem) => void;
  /** Copy one of an account's credentials, named by a `credentialChoices` id. */
  copyCredential: (item: VaultItem, choiceId: string) => void;
  copyUsername: (item: VaultItem) => void;
  edit: (item: VaultItem) => void;
  trash: (item: VaultItem) => void;
  favorite: (item: VaultItem) => void;
  /** Seal a one-time drop of this secret: a link, a code, and an expiry. */
  share: (item: VaultItem) => void;
  /** Grant this secret to a person or an agent on the local share ledger. */
  shareGrant: (item: VaultItem) => void;
  /** Grant a folder's scope to a person or an agent; absent, no folder Share. */
  shareFolderGrant?: (row: DirRow) => void;
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

function secretShare(item: VaultItem, actions: VaultTreeActions): MenuGroup {
  const ways: MenuItem[] = [
    {
      id: "share-drop",
      label: "Temporary drop",
      hint: "s",
      run: () => actions.share(item),
    },
  ];
  if (isCommandSection("/access")) {
    ways.push({
      id: "share-grant",
      label: "Person or agent",
      run: () => actions.shareGrant(item),
    });
  }
  return [
    {
      id: "share",
      label: "Share",
      submenu: [ways],
      run: () => undefined,
    },
  ];
}

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
            confirm: PURGE_CONFIRM,
            run: () => (actions.commitPurge ?? purge)(item),
          },
        ]
      : [],
  ];
}

/**
 * Copy rows for one item. A secret has a single value, so the menu offers
 * one clipboard action. An account holds several credentials, so its copy asks
 * which: one credential is a row named for it, several are a submenu, and none
 * is a row that stays visible and disabled. The username is its own row.
 */
function copyRows(
  item: VaultItem,
  actions: VaultTreeActions,
  verb: (
    id: string,
    label: string,
    hint: string,
    run: (item: VaultItem) => void,
    extra?: Partial<MenuItem>,
  ) => MenuItem,
): MenuItem[] {
  if (item.kind === "secret") {
    return [
      verb("copy-secret", "Copy to Clipboard", "y", actions.copySecret, {
        disabled: !canCopySecret(item),
      }),
    ];
  }
  const username_ = verb(
    "copy-username",
    "Copy username",
    "u",
    actions.copyUsername,
    { disabled: !username(item) },
  );
  // A credential kept on its own asks the same question an account does, of the
  // one method it holds, and has no username to copy (ADR 0179).
  const holder =
    item.kind === "account"
      ? item
      : item.kind === "credential"
        ? { methods: [item.method] }
        : null;
  if (holder === null) {
    return [
      verb("copy-secret", "Copy secret", "y", actions.copySecret, {
        disabled: !canCopySecret(item),
      }),
      username_,
    ];
  }
  const rest = item.kind === "account" ? [username_] : [];
  const choices = credentialChoices(holder);
  const entry = (
    choice: (typeof choices)[number],
    label: string,
  ): MenuItem => ({
    id: `copy:${choice.id}`,
    label,
    hint: choice.primary ? "y" : undefined,
    run: () => actions.copyCredential(item, choice.id),
  });
  const [only] = choices;
  if (only !== undefined && choices.length === 1) {
    return [entry(only, `Copy ${only.label.toLowerCase()}`), ...rest];
  }
  if (only === undefined) {
    return [
      {
        id: "copy-secret",
        label: "Copy",
        disabled: true,
        run: () => undefined,
      },
      ...rest,
    ];
  }
  return [
    {
      id: "copy-secret",
      label: "Copy",
      submenu: [choices.map((choice) => entry(choice, choice.label))],
      run: () => undefined,
    },
    ...rest,
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
    copyRows(item, actions, verb),
    [
      verb(
        "favorite",
        item.favorite ? "Unfavorite" : "Favorite",
        ".",
        actions.favorite,
      ),
    ],
    // Share opens the ways out. A sealed drop expires; a standing grant is a
    // person or an agent, and only when Access is part of this installation.
    ...(item.kind === "secret" ? [secretShare(item, actions)] : []),
    [verb("trash", "Trash", "x", actions.trash)],
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
    if (actions.inTrash) return [folder];
    // A folder shares as a standing grant to a person or an agent — folder
    // PAM is the folder's scope on the same ledger, labelled with its path.
    const share: MenuGroup =
      actions.shareFolderGrant && isCommandSection("/access")
        ? [
            {
              id: "share",
              label: "Share",
              submenu: [
                [
                  {
                    id: "share-grant",
                    label: "Person or agent",
                    run: () => actions.shareFolderGrant?.(row),
                  },
                ],
              ],
              run: () => undefined,
            },
          ]
        : [];
    return share.length > 0 ? [folder, [create], share] : [folder, [create]];
  }
  return actions.inTrash ? [[searchItem]] : [[create, searchItem]];
}
