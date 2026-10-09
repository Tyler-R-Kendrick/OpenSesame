import { useEffect, useMemo, useRef, useState } from "react";
import {
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { canPreviewVaultPath } from "./vault/preview-path.js";

import { vaultFilterLabel } from "@opensesame/app-core/lib/crumbs.js";
import { isCreatableItemKind } from "@opensesame/app-core/lib/item-kinds.js";
import { resolveFilterSlug } from "@opensesame/app-core/lib/vault-filter-slug.js";
import { itemCreatePath } from "@opensesame/app-core/lib/vault/item-path.js";
import {
  type DirRow,
  type VaultItem,
  itemTypeId,
  itemTypeRegistry,
  sortItems,
} from "@opensesame/vault-core";
import { IconChevronLeft } from "../components/Icons.js";
import { NavTree } from "../components/NavTree.js";
import { UpLink } from "../components/UpLink.js";
import { clearCommandBarSearch } from "../lib/command-bar/focus.js";
import { swipeBack } from "../lib/gestures.js";
import { AscendProvider, usePaneTrail } from "../lib/pane-trail.js";
import { useNarrow } from "../lib/use-narrow.js";
import { vaultListPath, vaultPane } from "../lib/vault-list-path.js";
import { useCopySecret, useVault, useVaultStore } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { NewItemFab } from "./vault/NewItemFab.js";
import { TrashCommands, trashItemActions } from "./vault/TrashCommands.js";
import { VaultActions } from "./vault/VaultActions.js";
import { VaultFilterMenu } from "./vault/VaultFilterMenu.js";
import { VaultShareSheet } from "./vault/VaultShareSheet.js";
import { VaultTree } from "./vault/VaultTree.js";
import { accountSecretToCopy } from "./vault/account-copy.js";
import { credentialChoices } from "./vault/account-credentials.js";
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

  const filter = resolveFilterSlug(params.get("f") ?? "all");
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
  const previewable = canPreviewVaultPath(
    location.pathname,
    itemId,
    params.get("workflow"),
  );
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
        if (item.kind === "account") {
          const value = accountSecretToCopy(item);
          if (value) void copySecret(value);
          return;
        }
        const value = concealedValue(item);
        if (value) void copySecret(value);
      },
      copyCredential: (item: VaultItem, choiceId: string) => {
        // An account's credential, or a credential kept on its own (ADR 0179).
        const holder =
          item.kind === "account"
            ? item
            : item.kind === "credential"
              ? { methods: [item.method] }
              : null;
        if (holder === null) return;
        const choice = credentialChoices(holder).find(
          (candidate) => candidate.id === choiceId,
        );
        void Promise.resolve(choice?.read()).then((value) => {
          if (value) void copySecret(value);
        });
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
      shareGrant: (item: VaultItem) =>
        navigate(`/vault/${item.id}?share=grant`),
      shareFolderGrant: (row: DirRow) =>
        navigate(
          `/vault?folder=${encodeURIComponent(row.key.slice("dir_".length))}&share=grant`,
        ),
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
  // A phone opens on the section tree, where the list pane is not drawn: the
  // tree answers to the list's target, and the Add button to the create one,
  // and the registry points at whichever copy is on screen.
  const treeListRef = useGuideTarget<HTMLDivElement>("vault.list");
  const listPath = vaultListPath(location.search, narrow);
  // Where New records itself for focus and the guide, wherever it is drawn.
  const recordNewItem = (element: HTMLAnchorElement | null) => {
    newItemRef.current = element;
    createRef(element);
  };

  // The list stays mounted behind the tree on a phone, and the prompt's words
  // are the shell's, not the pane's: a search typed on the list came back,
  // filter and all, the next time a tree entry opened it ("all" drew no rows
  // beside a count of three). Arriving at the tree ends it. An item is another
  // pane too, but Back from it returns to the same search, so only the tree
  // does.
  const wasShowing = useRef(showing);
  useEffect(() => {
    if (narrow && showing === "tree" && wasShowing.current !== "tree")
      clearCommandBarSearch();
    wasShowing.current = showing;
  }, [narrow, showing]);
  const ascend = usePaneTrail(showing);
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
        ? { pane: detailRef.current, to: listPath, up: "list" as const }
        : showing === "list"
          ? { pane: listPaneRef.current, to: "/vault", up: "tree" as const }
          : null;
    if (!target?.pane) return;
    const { to, up } = target;
    return swipeBack(target.pane, () => ascend(up, to));
  }, [showing, listPath, ascend]);

  return (
    <AscendProvider value={narrow ? ascend : null}>
      <div className="vault" data-pane={showing}>
        {/* The section tree: the rail's own tree, drawn where a phone looks.
          It is mounted only below the breakpoint, so the rail and this pane
          never hold two trees at once. */}
        <div
          className="vault__tree"
          ref={(element) => {
            treePaneRef.current = element;
            if (narrow) treeListRef(element);
            else treeListRef(null);
          }}
        >
          {narrow ? (
            <>
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
            emptyMessage={
              filter === "trash" ? "Trash is empty" : "Nothing here"
            }
            verbs={
              <>
                <UpLink
                  pane="tree"
                  className="icon-btn icon-btn--sm vault__back"
                  aria-label="Back to sections"
                  title="Back to sections"
                  to="/vault"
                >
                  <IconChevronLeft size={15} />
                </UpLink>
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
                    hidden={narrow}
                    createPath={createPath}
                    createRef={recordNewItem}
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

        {/* A phone's primary action, pinned to the corner of the tree and the
          list; the item's own screen has its own keys, and the trash has
          nothing to add to. */}
        <NewItemFab
          shown={narrow && showing !== "detail" && !inTrash}
          to={createPath}
          fabRef={recordNewItem}
        />
        <VaultShareSheet />
      </div>
    </AscendProvider>
  );
}

export { VaultWelcome } from "./vault/VaultWelcome.js";
