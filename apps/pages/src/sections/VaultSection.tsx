import { vaultFilterLabel } from "@opensesame/app-core/lib/crumbs.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

import { accessNewPath } from "@opensesame/app-core/lib/access-routes.js";
import { isCreatableItemKind } from "@opensesame/app-core/lib/item-kinds.js";
import { itemCreatePath } from "@opensesame/app-core/lib/vault/item-path.js";
import {
  type VaultItem,
  itemTypeId,
  itemTypeRegistry,
  sortItems,
} from "@opensesame/vault-core";
import { EmptyTip } from "../components/EmptyTip.js";
import { IconChevronLeft } from "../components/Icons.js";
import { NavTree } from "../components/NavTree.js";
import { swipeBack } from "../lib/gestures.js";
import { useNarrow } from "../lib/use-narrow.js";
import {
  PHONE_ALL_ITEMS,
  vaultListPath,
  vaultPane,
} from "../lib/vault-list-path.js";
import { useCopySecret, useVault, useVaultStore } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { TrashCommands, trashItemActions } from "./vault/TrashCommands.js";
import { VaultActions } from "./vault/VaultActions.js";
import { VaultFilterMenu } from "./vault/VaultFilterMenu.js";
import { VaultPathbar } from "./vault/VaultPathbar.js";
import { VaultTree } from "./vault/VaultTree.js";
import { WelcomeKeys } from "./vault/WelcomeKeys.js";
import { askForSearch } from "./vault/use-search-handoff.js";
import { useVaultFocus } from "./vault/use-vault-focus.js";
import "./vault.css";
import {
  chipTypeIds,
  concealedValue,
  shareText,
  username,
} from "@opensesame/app-core/sections/vault-section-model.js";

export function VaultSection() {
  const [params] = useSearchParams();
  const location = useLocation();
  const { itemId } = useParams();
  const { items, folders } = useVault();
  const store = useVaultStore();
  const copySecret = useCopySecret();
  const navigate = useNavigate();

  const filter = params.get("f") ?? "all";
  const inTrash = filter === "trash";
  const [armedPurgeId, setArmedPurgeId] = useState<string | null>(null);
  const folderId = params.get("folder");

  // Drop disposal (ADR 0062): every vault read sweeps the drop records, so a
  // drop that was opened or lapsed while away purges itself here.

  const visible = useMemo(() => {
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
  }, [items, filter, folderId, inTrash]);

  const narrow = useNarrow();
  // A phone draws one pane at a time, the first being the section tree.
  const showing = vaultPane(location.pathname, params);
  // The crumb's own label (a type's plural from its definition), so the
  // status line under a filter says what the crumb above it says — it used
  // to say "All items" under "Certificates".
  const title = folderId
    ? "Folder"
    : ((filter === "all" ? undefined : vaultFilterLabel(filter)) ??
      "All items");
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
      ...trashItemActions(store, armedPurgeId, setArmedPurgeId),
      favorite: (item: VaultItem) => void store.toggleFavorite(item.id),
      share: (item: VaultItem) => {
        if (shareText(item)) navigate(`/vault/${item.id}?share=drop`);
      },
      create: () => {
        if (inTrash) return;
        navigate(createPath);
      },
      shareGrant: () => navigate(accessNewPath("grants")),
      inTrash,
    }),
    [
      armedPurgeId,
      copySecret,
      createPath,
      inTrash,
      itemId,
      location.pathname,
      location.search,
      navigate,
      previewable,
      store,
    ],
  );
  useEffect(() => {
    if (!inTrash) setArmedPurgeId(null);
  }, [inTrash]);
  const total = items.filter((item) =>
    filter === "trash" ? item.deletedAt !== null : item.deletedAt === null,
  ).length;

  const detailRef = useRef<HTMLDivElement>(null);
  const listPaneRef = useRef<HTMLDivElement>(null);
  const treePaneRef = useRef<HTMLDivElement>(null);
  const newItemRef = useRef<HTMLAnchorElement>(null);
  const createRef = useGuideTarget<HTMLAnchorElement>("vault.create");
  const listRef = useGuideTarget<HTMLDivElement>("vault.list");
  const listPath = vaultListPath(location.search, narrow);

  useVaultFocus({
    tree: treePaneRef,
    list: listPaneRef,
    detail: detailRef,
    newItem: newItemRef,
  });
  useEffect(() => {
    // Only when one pane is on screen at a time: on a desktop all of them are
    // visible and there is nothing to go back from. From a list the way back
    // is the section tree; from an item it is the list.
    const target =
      showing === "detail"
        ? { pane: detailRef.current, to: listPath }
        : showing === "list"
          ? { pane: listPaneRef.current, to: "/vault" }
          : null;
    if (!target?.pane) return;
    const back = target.to;
    return swipeBack(target.pane, () => navigate(back));
  }, [showing, listPath, navigate]);

  return (
    <div className="vault" data-pane={showing}>
      {/* The section tree: the rail's own tree, drawn where a phone looks.
          It is mounted only below the breakpoint, so the rail and this pane
          never hold two trees at once. */}
      <div className="vault__tree" ref={treePaneRef}>
        {narrow ? (
          <>
            {/* The list's own command row, so adding, importing and backing
                up are on the screen a phone opens on. Search jumps to the
                list of everything with its prompt open. */}
            <VaultPathbar
              verbs={<VaultActions createPath={createPath} />}
              search={() => {
                askForSearch();
                navigate(PHONE_ALL_ITEMS);
              }}
            />
            <NavTree />
          </>
        ) : null}
      </div>
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
              <Link
                className="icon-btn icon-btn--sm vault__back"
                aria-label="Back to sections"
                title="Back to sections"
                to="/vault"
              >
                <IconChevronLeft size={15} />
              </Link>
              <VaultFilterMenu
                items={items}
                folders={folders}
                typeIds={chipTypeIds(
                  items.filter((item) => item.deletedAt === null),
                )}
                filter={filter}
                folderId={folderId}
              />
              {inTrash ? (
                <TrashCommands
                  items={visible}
                  armedId={armedPurgeId}
                  onRestore={(item) => actions.restore(item)}
                  onPurge={(item) => actions.purge(item)}
                />
              ) : (
                <VaultActions
                  createPath={createPath}
                  createRef={(element) => {
                    newItemRef.current = element;
                    createRef(element);
                  }}
                />
              )}
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
 * cursor previews items, so this pane only states what the list beside it
 * holds and hands over the keys for the filter the list is showing.
 */
export function VaultWelcome() {
  const { items } = useVault();
  const [params] = useSearchParams();
  const filter = params.get("f") ?? "all";
  const inTrash = filter === "trash";
  const shown = items.filter((item) => {
    if (inTrash) return item.deletedAt !== null;
    if (item.deletedAt !== null) return false;
    if (filter === "favorites") return item.favorite;
    return filter === "all" || itemTypeId(item) === filter;
  });
  const what =
    filter === "all"
      ? null
      : (vaultFilterLabel(filter) ?? filter).toLowerCase();

  if (shown.length === 0) {
    // The list pane states the empty list and carries the actions that fill
    // it. The buffer says what is there and hands over the keys — the same
    // two mono lines it shows a full vault (DESIGN.md § Empty states).
    return (
      <div className="buffer">
        <p className="buffer__line">
          {inTrash
            ? "trash is empty"
            : what
              ? `no ${what} yet`
              : "nothing sealed yet"}
        </p>
        <WelcomeKeys inTrash={inTrash} empty />
      </div>
    );
  }

  return (
    <div className="buffer">
      <p className="buffer__line">
        {shown.length} {shown.length === 1 ? "item" : "items"}
        {what ? ` · ${what}` : ""}
      </p>
      <EmptyTip tip="vaultMove" />
      <WelcomeKeys inTrash={inTrash} empty={false} />
    </div>
  );
}
