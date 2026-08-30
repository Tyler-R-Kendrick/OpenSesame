import { useEffect, useMemo, useRef } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

import { sweepDrops } from "../lib/vault/drop.js";
import { useCopySecret, useVault, useVaultStore } from "../lib/vault/hooks.js";
import { stashImportFile } from "../lib/vault/import/handoff.js";
import {
  type Folder,
  type ItemKind,
  KIND_PLURAL,
  type VaultItem,
  sortItems,
} from "../lib/vault/model.js";
import { VaultTree } from "./vault/VaultTree.js";
import "./vault.css";

const KIND_ORDER: ItemKind[] = [
  "login",
  "passkey",
  "card",
  "secret",
  "drop",
  "note",
  "certificate",
];

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
      {chip("?f=favorites", filter === "favorites", "Favorites")}
      {KIND_ORDER.filter((kind) => live.some((item) => item.kind === kind)).map(
        (kind) => chip(`?f=${kind}`, filter === kind, KIND_PLURAL[kind]),
      )}
      {folders.map((folder) =>
        chip(
          `?folder=${encodeURIComponent(folder.id)}`,
          folderId === folder.id,
          folder.name,
        ),
      )}
      {chip("?f=trash", filter === "trash", "Trash")}
      <Link className="vault__chip" to="/vault/health">
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
  return (
    <>
      <button
        type="button"
        className={verb ? "vtree__verb" : "btn btn--sm"}
        onClick={() => fileRef.current?.click()}
      >
        {verb ? "import" : "Import"}
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

function isItemKind(value: string): value is ItemKind {
  return KIND_ORDER.some((kind) => kind === value);
}

function concealedValue(item: VaultItem): string | null {
  if (item.kind === "login") return item.password;
  if (item.kind === "secret") return item.value;
  if (item.kind === "card") return item.number;
  if (item.kind === "certificate") return item.privateKeyPem;
  return null;
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
          item.kind !== filter
        ) {
          return false;
        }
        return true;
      }),
    );
  }, [items, filter, folderId]);

  const detailOpen = location.pathname !== "/vault";
  const title = folderId ? "Folder" : (FILTER_TITLE.get(filter) ?? "All items");
  const createKind = isItemKind(filter) ? filter : "login";
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

  return (
    <div className="vault" data-pane={detailOpen ? "detail" : "list"}>
      <div className="vault__list">
        <MobileFilters
          items={items}
          folders={folders}
          filter={filter}
          folderId={folderId}
        />

        {visible.length === 0 ? (
          <div className="empty">
            <h2>Nothing here yet</h2>
            <p>
              {filter === "trash"
                ? "Deleted items wait here until you purge them."
                : "Human items on this device: logins, passkeys, notes, certificates, and secrets. Import a .env or password export, or authorize a Host connector instead."}
            </p>
            {filter !== "trash" ? (
              // On narrow screens the detail pane is not rendered, so this is
              // the only empty state a new arrival sees. It has to offer the
              // import, not just mention it.
              <div className="actions">
                <Link
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
                <Link className="vtree__verb" to={`/vault/new/${createKind}`}>
                  new
                </Link>
                <ImportButton verb />
              </>
            }
          />
        )}
      </div>

      <div className="vault__detail">
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
  const { items, header } = useVault();
  const live = items.filter((item) => item.deletedAt === null);

  if (live.length === 0) {
    return (
      <div className="detail">
        <div className="empty">
          <h2>Nothing sealed on this device</h2>
          <p>
            This store is for human items on this machine. Host connectors and
            agent grants live on the Host — they never appear here as secrets.
            Start with a .env import or add a login by hand.
          </p>
          <div className="actions">
            <Link className="btn btn--primary btn--sm" to="/vault/new/login">
              Add your first login
            </Link>
            {/* An empty vault is exactly when someone is arriving from another
                manager, so the import is offered here and not only in Settings. */}
            <ImportButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="buffer">
      <p className="buffer__line">
        {live.length} items, sealed — decrypted in memory for this session only.
        Locking discards the key
        {header?.kdf
          ? `; it is re-derived with ${header.kdf.iterations.toLocaleString()} PBKDF2 iterations`
          : header
            ? "; unlock again with an enrolled passkey, PIN, or password"
            : ""}
        .
      </p>
      <p className="buffer__keys">
        j/k browse · enter open · n new · / search · ? keys
      </p>
    </div>
  );
}
