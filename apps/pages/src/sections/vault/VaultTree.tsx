import { type BoundaryValue, isString } from "@opensesame/os-domain";
import type {
  ContextMenuItem,
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  FileTreeOptions,
  FileTreeRowDecoration,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef } from "react";
import { registerVaultKeymap } from "../../lib/keymap.js";
import { activeProject } from "../../lib/projects.js";
import type { Folder, ItemKind, VaultItem } from "../../lib/vault/model.js";
import { itemPath, pathSegment } from "../../lib/vault/paths.js";
import { readFile, writeFile } from "../../lib/vfs.js";
import { formatExpiry } from "./DropCeremony.js";

const EXPANSION_PATH = "config/tree-expansion";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DECORATION_SPRITE = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  <symbol id="vault-tree-clock" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/></symbol>
  <symbol id="vault-tree-star" viewBox="0 0 16 16"><path d="m8 1.8 1.85 3.75 4.14.6-3 2.92.71 4.12L8 11.25l-3.7 1.94.71-4.12-3-2.92 4.14-.6z" fill="currentColor"/></symbol>
</svg>`;

const KIND_TREE_ICON = new Map<ItemKind, string>([
  ["login", "file-tree-icon-lock"],
  ["passkey", "file-tree-icon-lock"],
  ["card", "file-tree-builtin-database"],
  ["secret", "file-tree-icon-lock"],
  ["drop", "file-tree-builtin-zip"],
  ["note", "file-tree-builtin-text"],
  ["certificate", "file-tree-icon-lock"],
]);

type TreeInput = {
  paths: string[];
  directoryPaths: string[];
  byPath: Map<string, VaultItem>;
  pathById: Map<string, string>;
  iconsByName: Record<string, string>;
};

type VaultTreeActions = {
  open: (item: VaultItem) => void;
  copySecret: (item: VaultItem) => void;
  copyUsername: (item: VaultItem) => void;
  edit: (item: VaultItem) => void;
  trash: (item: VaultItem) => void;
  favorite: (item: VaultItem) => void;
  share: (item: VaultItem) => void;
  create: () => void;
};

type VaultTreeProps = {
  items: VaultItem[];
  folders: Folder[];
  activeItemId?: string;
  actions: VaultTreeActions;
  onFocus: (item: VaultItem | null, path: string | null) => void;
};

function uniquePath(
  base: string,
  directory: boolean,
  used: Set<string>,
): string {
  let path = directory ? `${base}/` : base;
  let suffix = 2;
  while (used.has(path.replace(/\/$/, ""))) {
    path = directory ? `${base} (${suffix})/` : `${base} (${suffix})`;
    suffix += 1;
  }
  used.add(path.replace(/\/$/, ""));
  return path;
}

function isDirectory(
  item: FileTreeItemHandle | null,
): item is FileTreeDirectoryHandle {
  return item?.isDirectory() === true;
}

function buildTreeInput(items: VaultItem[], folders: Folder[]): TreeInput {
  const paths: string[] = [];
  const directoryPaths: string[] = [];
  const byPath = new Map<string, VaultItem>();
  const pathById = new Map<string, string>();
  const iconsByName: Record<string, string> = {};
  const folderPaths = new Map<string, string>();
  const used = new Set<string>();

  for (const folder of folders) {
    const path = uniquePath(pathSegment(folder.name), true, used);
    folderPaths.set(folder.id, path);
    directoryPaths.push(path);
    paths.push(path);
  }

  for (const item of items) {
    const folderPath = item.folderId
      ? folderPaths.get(item.folderId)
      : undefined;
    const base = itemPath(item, []).replace(/\/$/, "");
    const path = uniquePath(`${folderPath ?? ""}${base}`, false, used);
    paths.push(path);
    byPath.set(path, item);
    pathById.set(item.id, path);
    const name = path.split("/").at(-1);
    const icon = KIND_TREE_ICON.get(item.kind);
    if (name && icon) iconsByName[name] = icon;
  }

  return { paths, directoryPaths, byPath, pathById, iconsByName };
}

async function loadExpandedDefault(tomb: string): Promise<string[]> {
  try {
    const parsed: BoundaryValue = JSON.parse(
      decoder.decode(await readFile(tomb, EXPANSION_PATH)),
    );
    if (!Array.isArray(parsed)) return [];
    const expanded: string[] = [];
    for (const path of parsed) if (isString(path)) expanded.push(path);
    return expanded;
  } catch {
    return [];
  }
}

async function saveExpandedDefault(
  tomb: string,
  paths: string[],
): Promise<void> {
  await writeFile(tomb, EXPANSION_PATH, encoder.encode(JSON.stringify(paths)));
}

export const vaultTreeSeams = {
  useFileTree,
  FileTree,
  activeTomb: () => activeProject().id,
  loadExpanded: loadExpandedDefault,
  saveExpanded: saveExpandedDefault,
};

function decoration(item: VaultItem | undefined): FileTreeRowDecoration | null {
  if (!item) return null;
  if (item.sample) return { text: "SYNTHETIC", title: "Sample data" };
  if (item.kind === "drop") {
    return {
      icon: "vault-tree-clock",
      title: `Expires ${formatExpiry(item.expiresAt)}`,
    };
  }
  return item.favorite ? { icon: "vault-tree-star", title: "Favorite" } : null;
}

export function VaultTree({
  items,
  folders,
  activeItemId,
  actions,
  onFocus,
}: VaultTreeProps) {
  const input = useMemo(() => buildTreeInput(items, folders), [folders, items]);
  const inputRef = useRef(input);
  inputRef.current = input;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const activeItemIdRef = useRef(activeItemId);
  activeItemIdRef.current = activeItemId;
  const options: FileTreeOptions = {
    paths: input.paths,
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    initialExpansion: "closed",
    search: true,
    icons: {
      set: "complete",
      colored: false,
      spriteSheet: DECORATION_SPRITE,
      byFileName: input.iconsByName,
    },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: "button",
        buttonVisibility: "when-needed",
      },
    },
    onSelectionChange: (paths) => {
      const item =
        paths.length === 1
          ? inputRef.current.byPath.get(paths[0] ?? "")
          : undefined;
      if (item) actionsRef.current.open(item);
    },
    renderRowDecoration: ({ item }) =>
      decoration(inputRef.current.byPath.get(item.path)),
  };
  const { model } = vaultTreeSeams.useFileTree(options);
  const tomb = vaultTreeSeams.activeTomb();
  const persistedRef = useRef("");
  const persistenceReadyRef = useRef(false);

  useEffect(() => {
    const expanded = input.directoryPaths.filter((path) => {
      const handle = model.getItem(path);
      return isDirectory(handle) && handle.isExpanded();
    });
    model.resetPaths(input.paths, { initialExpandedPaths: expanded });
    const activePath = activeItemId
      ? input.pathById.get(activeItemId)
      : undefined;
    if (activePath) model.focusPath(activePath);
    else model.focusFirstItem();
  }, [activeItemId, input, model]);

  useEffect(() => {
    let live = true;
    persistenceReadyRef.current = false;
    void vaultTreeSeams.loadExpanded(tomb).then((saved) => {
      if (!live) return;
      const valid = saved.filter((path) =>
        inputRef.current.directoryPaths.includes(path),
      );
      persistedRef.current = JSON.stringify(valid);
      model.resetPaths(inputRef.current.paths, { initialExpandedPaths: valid });
      const activePath = activeItemIdRef.current
        ? inputRef.current.pathById.get(activeItemIdRef.current)
        : undefined;
      if (activePath) model.focusPath(activePath);
      else model.focusFirstItem();
      persistenceReadyRef.current = true;
    });
    return () => {
      live = false;
    };
  }, [model, tomb]);

  useEffect(
    () =>
      model.subscribe(() => {
        const path = model.getFocusedPath();
        onFocus(
          path ? (inputRef.current.byPath.get(path) ?? null) : null,
          path,
        );
        if (!persistenceReadyRef.current) return;
        const expanded = inputRef.current.directoryPaths.filter((candidate) => {
          const handle = model.getItem(candidate);
          return isDirectory(handle) && handle.isExpanded();
        });
        const serialized = JSON.stringify(expanded);
        if (serialized === persistedRef.current) return;
        persistedRef.current = serialized;
        void vaultTreeSeams.saveExpanded(tomb, expanded).catch(() => undefined);
      }),
    [model, onFocus, tomb],
  );

  useEffect(() => {
    const focusedItem = () => {
      const path = model.getFocusedPath();
      return path ? inputRef.current.byPath.get(path) : undefined;
    };
    return registerVaultKeymap({
      next: () => model.focusNextItem(),
      previous: () => model.focusPreviousItem(),
      first: () => model.focusFirstItem(),
      last: () => model.focusLastItem(),
      enter: () => {
        const item = model.getFocusedItem();
        if (isDirectory(item)) item.expand();
        else {
          const focused = focusedItem();
          if (focused) actions.open(focused);
        }
      },
      parent: () => {
        const item = model.getFocusedItem();
        if (isDirectory(item) && item.isExpanded()) item.collapse();
        else model.focusParentItem();
      },
      activate: () => {
        const item = model.getFocusedItem();
        if (isDirectory(item)) item.toggle();
        else {
          const focused = focusedItem();
          if (focused) actions.open(focused);
        }
      },
      search: () => model.openSearch(),
      closeSearch: () => model.closeSearch(),
      copySecret: () => {
        const item = focusedItem();
        if (item) actions.copySecret(item);
      },
      copyUsername: () => {
        const item = focusedItem();
        if (item) actions.copyUsername(item);
      },
      edit: () => {
        const item = focusedItem();
        if (item) actions.edit(item);
      },
      trash: () => {
        const item = focusedItem();
        if (item) actions.trash(item);
      },
      create: actions.create,
      favorite: () => {
        const item = focusedItem();
        if (item) actions.favorite(item);
      },
      share: () => {
        const item = focusedItem();
        if (item) actions.share(item);
      },
    });
  }, [actions, model]);

  const Tree = vaultTreeSeams.FileTree;
  return (
    <Tree
      className="vault-tree"
      model={model}
      aria-label="Vault items"
      renderContextMenu={(entry: ContextMenuItem, context) => {
        const item = input.byPath.get(entry.path);
        if (!item) return null;
        const run = (action: () => void) => {
          context.close({ restoreFocus: false });
          action();
        };
        return (
          <div className="vault-tree-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => run(() => actions.open(item))}
            >
              Open
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => run(() => actions.favorite(item))}
            >
              {item.favorite ? "Unfavorite" : "Favorite"}
            </button>
            {item.kind === "secret" ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => run(() => actions.share(item))}
              >
                Share once
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => run(() => actions.edit(item))}
            >
              Edit
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => run(() => actions.trash(item))}
            >
              Trash
            </button>
          </div>
        );
      }}
    />
  );
}
