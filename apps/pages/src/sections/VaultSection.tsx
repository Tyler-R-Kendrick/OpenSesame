import { useEffect, useMemo, useRef } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

import { isString } from "@opensesame/os-domain";
import { IconDownload, IconPlus } from "../components/Icons.js";
import { swipeBack } from "../lib/gestures.js";
import { sweepDrops } from "../lib/vault/drop.js";
import { useCopySecret, useVault, useVaultStore } from "../lib/vault/hooks.js";
import { stashImportFile } from "../lib/vault/import/handoff.js";
import {
  definitionFor,
  itemTypeId,
  itemTypeRegistry,
  readItemField,
  typePlural,
} from "../lib/vault/item-types.js";
import { type Folder, type VaultItem, sortItems } from "../lib/vault/model.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { VaultTree } from "./vault/VaultTree.js";
import "./vault.css";

/**
 * The filter chips, in registry order (built-ins first), for the types this
 * vault actually holds. Derived rather than listed: a plugin-defined type is a
 * type like any other, so it earns its own chip the moment an item exists
 * (ADR 0087 §1). A hardcoded list would quietly bucket every community type
 * into one undifferentiated pile.
 */
function chipTypeIds(live: readonly VaultItem[]): readonly string[] {
  const present = new Set(live.map(itemTypeId));
  const ordered = itemTypeRegistry()
    .list()
    .map(({ definition }) => definition.metadata.id)
    .filter((id) => present.has(id));
  // A type whose definition is not installed here still deserves its chip;
  // the label falls back to the id rather than the item vanishing from view.
  const orphans = [...present].filter((id) => !itemTypeRegistry().has(id));
  return [...ordered, ...orphans.sort()];
}

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

/** A filter chip a guide can name. Same markup as the untracked ones. */
function GuidedChip({
  guideId,
  to,
  isActive,
  label,
}: {
  guideId: string;
  to: string;
  isActive: boolean;
  label: string;
}) {
  const ref = useGuideTarget<HTMLAnchorElement>(guideId);
  return (
    <Link
      ref={ref}
      to={to}
      className={`vault__chip${isActive ? " is-active" : ""}`}
      aria-current={isActive ? "true" : undefined}
    >
      {label}
    </Link>
  );
}

/**
 * The rail carries these filters on desktop, but it is hidden on a phone — so the
 * list header grows a scrolling chip row and nothing becomes unreachable there.
 */
function MobileFilters({
  items,
  folders,
  filter,
  folderId,
}: {
  items: VaultItem[];
  folders: Folder[];
  filter: string;
  folderId: string | null;
}) {
  const live = items.filter((item) => item.deletedAt === null);
  const healthRef = useGuideTarget<HTMLAnchorElement>("vault.health");
  const chip = (query: string, isActive: boolean, label: string) => (
    <Link
      key={query || "all"}
      to={`/vault${query}`}
      className={`vault__chip${isActive ? " is-active" : ""}`}
      aria-current={isActive ? "true" : undefined}
    >
      {label}
    </Link>
  );

  return (
    <fieldset className="vault__chips" aria-label="Filter items">
      {chip("", filter === "all" && !folderId, "All")}
      <GuidedChip
        key="favorites"
        guideId="vault.filter.favorites"
        to="/vault?f=favorites"
        isActive={filter === "favorites"}
        label="Favorites"
      />
      {chipTypeIds(live).map((typeId) =>
        typeId === "login" ? (
          <GuidedChip
            key="login"
            guideId="vault.filter.logins"
            to="/vault?f=login"
            isActive={filter === "login"}
            label={typePlural(typeId)}
          />
        ) : (
          chip(`?f=${typeId}`, filter === typeId, typePlural(typeId))
        ),
      )}
      {folders.map((folder) =>
        chip(
          `?folder=${encodeURIComponent(folder.id)}`,
          folderId === folder.id,
          folder.name,
        ),
      )}
      {chip("?f=trash", filter === "trash", "Trash")}
      <Link ref={healthRef} className="vault__chip" to="/vault/health">
        Health
      </Link>
    </fieldset>
  );
}

const IMPORT_ACCEPT =
  ".env,.csv,.json,.1pux,.zip,.kdbx,text/plain,text/csv,application/json";

/**
 * Import starts at the OS file picker, not at a settings screen: the chosen
 * file is handed to the Settings import panel through `stashImportFile` so
 * clicking Import here is the only click before the file dialog opens.
 */
function ImportButton({ verb = false }: { verb?: boolean }) {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const guideRef = useGuideTarget<HTMLButtonElement>("vault.import");
  return (
    <>
      <button
        ref={guideRef}
        type="button"
        className={verb ? "icon-btn icon-btn--sm" : "btn btn--sm"}
        aria-label={verb ? "Import items" : undefined}
        title={verb ? "Import items" : undefined}
        onClick={() => fileRef.current?.click()}
      >
        {verb ? <IconDownload size={15} /> : "Import"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={IMPORT_ACCEPT}
        className="visually-hidden"
        aria-label="Choose a file to import"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          stashImportFile(file);
          navigate("/settings/data#import");
        }}
      />
    </>
  );
}

/** Any registered type may be the one a filtered "+ new" creates. */
function isRegisteredType(value: string): boolean {
  return itemTypeRegistry().has(value);
}

function concealedValue(item: VaultItem): string | null {
  if (item.kind === "login") return item.password;
  if (item.kind === "secret") return item.value;
  if (item.kind === "card") return item.number;
  if (item.kind === "certificate") return item.privateKeyPem;
  // A plugin-defined type already says which field is its secret — the same
  // field that becomes line one of its native entry (ADR 0087 §3).
  const definition = definitionFor(item);
  const secretField = definition?.spec.native.secret;
  if (
    definition === undefined ||
    secretField === undefined ||
    secretField === null
  ) {
    return null;
  }
  const field = definition.spec.sections
    .flatMap((section) => section.fields)
    .find((candidate) => candidate.id === secretField);
  if (field === undefined) return null;
  const value = readItemField(item, field);
  return isString(value) && value !== "" ? value : null;
}

function username(item: VaultItem): string | null {
  return item.kind === "login" || item.kind === "passkey"
    ? item.username
    : null;
}

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
  const createKind = isRegisteredType(filter) ? filter : "login";
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
      open: (item: VaultItem) =>
        navigate(`/vault/${item.id}${location.search}`),
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
      create: () => navigate(`/vault/new/${createKind}`),
    }),
    [
      copySecret,
      createKind,
      itemId,
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
  // Exactly one of the two "new item" affordances is on screen at a time —
  // the empty state or the list header — so one binding covers both.
  const createRef = useGuideTarget<HTMLAnchorElement>("vault.create");
  const listRef = useGuideTarget<HTMLDivElement>("vault.list");
  const listPath = `/vault${location.search}`;
  useEffect(() => {
    const pane = detailRef.current;
    // Only when the buffer is the pane on screen: on a desktop both panes
    // are visible and there is nothing to go back from.
    if (!pane || !detailOpen) return;
    return swipeBack(pane, () => navigate(listPath));
  }, [detailOpen, listPath, navigate]);

  return (
    <div className="vault" data-pane={detailOpen ? "detail" : "list"}>
      <div className="vault__list" ref={listRef}>
        <MobileFilters
          items={items}
          folders={folders}
          filter={filter}
          folderId={folderId}
        />

        {visible.length === 0 ? (
          <div className="empty">
            <h2>{filter === "trash" ? "Trash is empty" : "Nothing here"}</h2>
            {filter !== "trash" ? (
              // On narrow screens the detail pane is not rendered, so this is
              // the only empty state a new arrival sees. It has to offer the
              // import, not just mention it.
              <div className="actions">
                <Link
                  ref={createRef}
                  className="btn btn--primary btn--sm"
                  to={`/vault/new/${createKind}`}
                >
                  New item
                </Link>
                <ImportButton />
              </div>
            ) : null}
          </div>
        ) : (
          <VaultTree
            items={visible}
            folders={treeFolders}
            activeItemId={itemId}
            actions={actions}
            title={title}
            total={total}
            verbs={
              <>
                {/* Import sits beside new even with items present — arriving
                    from another manager should not require an empty vault or
                    a hunt through Settings to find it. */}
                <Link
                  ref={createRef}
                  className="icon-btn icon-btn--sm"
                  aria-label="New item"
                  title="New item (n)"
                  to={`/vault/new/${createKind}`}
                >
                  <IconPlus size={15} />
                </Link>
                <ImportButton verb />
              </>
            }
          />
        )}
      </div>

      {/* Dragging the buffer rightwards goes back to the list — the
          platform's own back gesture, and the touch twin of the ← key. */}
      <div className="vault__detail" ref={detailRef}>
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
    // it. Saying it twice, side by side, only asks which one to believe.
    return (
      <div className="buffer">
        <p className="buffer__keys">n new · / search · ? keys</p>
      </div>
    );
  }

  return (
    <div className="buffer">
      <p className="buffer__line">
        {live.length} {live.length === 1 ? "item" : "items"}
      </p>
      <p className="buffer__keys">
        j/k browse · enter open · n new · / search · ? keys
      </p>
    </div>
  );
}
