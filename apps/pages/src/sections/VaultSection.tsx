import { useEffect, useMemo, useRef } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

import { isCreatableItemKind } from "@opensesame/app-core/lib/item-kinds.js";
import { sweepDrops } from "@opensesame/app-core/lib/vault/drop.js";
import { itemCreatePath } from "@opensesame/app-core/lib/vault/item-path.js";
import {
  type VaultItem,
  itemTypeId,
  itemTypeRegistry,
  sortItems,
} from "@opensesame/vault-core";
import { EmptyTip, emptyTips } from "../components/EmptyTip.js";
import { IconPlus } from "../components/Icons.js";
import { keyboardIsIdle, landFocus } from "../lib/focus.js";
import { swipeBack } from "../lib/gestures.js";
import { useCopySecret, useVault, useVaultStore } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { VaultFilterMenu } from "./vault/VaultFilterMenu.js";
import { VaultTree } from "./vault/VaultTree.js";
import "./vault.css";
import {
  chipTypeIds,
  concealedValue,
  username,
} from "@opensesame/app-core/sections/vault-section-model.js";

const FILTER_TITLE = new Map([
  ["all", "All items"],
  ["favorites", "Favorites"],
  ["trash", "Trash"],
  ["login", "Logins"],
  ["passkey", "Passkeys"],
  ["card", "Cards"],
  ["secret", "Secrets"],
  ["drop", "Drops"],
  ["note", "Secure notes"],
]);

export function VaultSection() {
  const [params] = useSearchParams();
  const location = useLocation();
  const { itemId } = useParams();
  const { items, folders, status } = useVault();
  const store = useVaultStore();
  const copySecret = useCopySecret();
  const navigate = useNavigate();

  const filter = params.get("f") ?? "all";
  const folderId = params.get("folder");

  // Drop disposal (ADR 0062): every vault read sweeps the drop records, so a
  // drop that was opened or lapsed while away purges itself here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the unlock transition is the trigger — items/store are read at that moment, not watched
  useEffect(() => {
    if (status !== "unlocked") return;
    void sweepDrops(items, (id) => store.purgeItem(id));
  }, [status]);

  const visible = useMemo(() => {
    const inTrash = filter === "trash";
    return sortItems(
      items.filter((item) => {
        if (inTrash ? item.deletedAt === null : item.deletedAt !== null)
          return false;
        if (folderId && item.folderId !== folderId) return false;
        if (filter === "favorites" && !item.favorite) return false;
        if (
          filter !== "all" &&
          filter !== "favorites" &&
          filter !== "trash" &&
          itemTypeId(item) !== filter
        ) {
          return false;
        }
        return true;
      }),
    );
  }, [items, filter, folderId]);

  const detailOpen = location.pathname !== "/vault";
  const title = folderId ? "Folder" : (FILTER_TITLE.get(filter) ?? "All items");
  // A filtered "+ new" creates the filter's kind only when that kind may be
  // created on this installation (SURFACE-08); otherwise the default kind.
  const createPath = itemCreatePath(
    itemTypeRegistry().has(filter) && isCreatableItemKind(filter)
      ? filter
      : undefined,
    folderId,
  );
  const treeFolders = useMemo(() => {
    if (folderId) return [];
    if (
      filter === "all" &&
      visible.length === items.filter((item) => item.deletedAt === null).length
    ) {
      return folders;
    }
    const used = new Set(visible.map((item) => item.folderId).filter(Boolean));
    return folders.filter((folder) => used.has(folder.id));
  }, [filter, folderId, folders, items, visible]);
  // Moving the cursor with the keyboard previews that item in the buffer,
  // ranger-style — but never while an editor, the health report, or a new-item
  // ceremony owns the pane.
  const previewable =
    location.pathname === "/vault" ||
    (itemId !== undefined && !location.pathname.endsWith("/edit"));
  const actions = useMemo(
    () => ({
      open: (item: VaultItem) => {
        // Enter on the item the cursor already previewed must not push a
        // second entry for the same place — Back would then land on the very
        // screen it was pressed on, and read as doing nothing.
        const path = `/vault/${item.id}`;
        navigate(`${path}${location.search}`, {
          replace: location.pathname === path,
        });
      },
      preview: (item: VaultItem) => {
        if (previewable && item.id !== itemId) {
          navigate(`/vault/${item.id}${location.search}`, { replace: true });
        }
      },
      copySecret: (item: VaultItem) => {
        const value = concealedValue(item);
        if (value) void copySecret(value);
      },
      copyUsername: (item: VaultItem) => {
        const value = username(item);
        if (value) void copySecret(value);
      },
      edit: (item: VaultItem) => navigate(`/vault/${item.id}/edit`),
      trash: (item: VaultItem) => void store.trashItem(item.id),
      favorite: (item: VaultItem) => void store.toggleFavorite(item.id),
      share: (item: VaultItem) => {
        if (item.kind === "secret") navigate(`/vault/${item.id}?share=drop`);
      },
      create: () => navigate(createPath),
    }),
    [
      copySecret,
      createPath,
      itemId,
      location.pathname,
      location.search,
      navigate,
      previewable,
      store,
    ],
  );
  const total = items.filter((item) =>
    filter === "trash" ? item.deletedAt !== null : item.deletedAt === null,
  ).length;

  const detailRef = useRef<HTMLDivElement>(null);
  const listPaneRef = useRef<HTMLDivElement>(null);
  const newItemRef = useRef<HTMLAnchorElement>(null);
  const createRef = useGuideTarget<HTMLAnchorElement>("vault.create");
  const listRef = useGuideTarget<HTMLDivElement>("vault.list");
  const listPath = `/vault${location.search}`;

  // Every navigation into or within the vault — an unlock, `g v`, Back from an
  // item, from settings, from an editor — lands the keyboard where the cursor
  // is: the tree, or the "New item" link of an empty vault. It yields to a
  // caret something else already placed (an editor's first field), and on a
  // phone, where only one pane is on screen, it follows the visible pane: a
  // hidden tree cannot hold focus, and a Back that hides the detail must hand
  // the keyboard back to the list rather than leave it on `<body>`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key is the navigation itself — the effect re-runs per arrival, and reads the panes at that moment
  useEffect(() => {
    const list = listPaneRef.current;
    const detail = detailRef.current;
    if (!list || !detail) return;
    const hidden = (pane: HTMLElement) =>
      getComputedStyle(pane).display === "none";
    const active = document.activeElement;
    const idle = keyboardIsIdle();
    if (!hidden(list)) {
      const strandedInDetail =
        hidden(detail) && active !== null && detail.contains(active);
      if (idle || strandedInDetail) {
        if (!landFocus(list.querySelector('[role="tree"]:not([hidden])'))) {
          landFocus(newItemRef.current);
        }
      }
      return;
    }
    if (idle || (active !== null && list.contains(active))) landFocus(detail);
  }, [location.key]);
  useEffect(() => {
    const pane = detailRef.current;
    // Only when the buffer is the pane on screen: on a desktop both panes
    // are visible and there is nothing to go back from.
    if (!pane || !detailOpen) return;
    return swipeBack(pane, () => navigate(listPath));
  }, [detailOpen, listPath, navigate]);

  return (
    <div className="vault" data-pane={detailOpen ? "detail" : "list"}>
      <div
        className="vault__list"
        ref={(element) => {
          listPaneRef.current = element;
          listRef(element);
        }}
      >
        <VaultTree
          items={visible}
          folders={treeFolders}
          activeItemId={itemId}
          actions={actions}
          title={title}
          total={total}
          emptyMessage={filter === "trash" ? "Trash is empty" : "Nothing here"}
          verbs={
            <>
              <VaultFilterMenu
                items={items}
                folders={folders}
                typeIds={chipTypeIds(
                  items.filter((item) => item.deletedAt === null),
                )}
                filter={filter}
                folderId={folderId}
              />
              <Link
                ref={(element) => {
                  newItemRef.current = element;
                  createRef(element);
                }}
                className="icon-btn icon-btn--sm"
                aria-label="New item"
                title="New item (n)"
                to={createPath}
              >
                <IconPlus size={15} />
              </Link>
            </>
          }
        />
      </div>

      {/* Dragging the buffer rightwards goes back to the list — the
          platform's own back gesture, and the touch twin of the ← key. */}
      <div className="vault__detail" ref={detailRef} tabIndex={-1}>
        <Outlet />
      </div>
    </div>
  );
}

/**
 * The buffer before the cursor lands on a file. No dashboard: moving the
 * cursor previews items, so this pane only states what is sealed and hands
 * over the keys.
 */
export function VaultWelcome() {
  const { items } = useVault();
  const live = items.filter((item) => item.deletedAt === null);

  if (live.length === 0) {
    // The list pane states the empty vault and carries the actions that fill
    // it. The buffer says what is sealed and hands over the keys — the same
    // two mono lines it shows a full vault (DESIGN.md § Empty states), not a
    // second copy of the list pane's tip beside the first.
    return (
      <div className="buffer">
        <p className="buffer__line">nothing sealed yet</p>
        <p className="buffer__keys">n new · import · ? keys</p>
      </div>
    );
  }

  return (
    <div className="buffer">
      <p className="buffer__line">
        {live.length} {live.length === 1 ? "item" : "items"}
      </p>
      <EmptyTip>{emptyTips.vaultMove}</EmptyTip>
      <p className="buffer__keys">enter open · n new · / search · ? keys</p>
    </div>
  );
}
