import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  IconCard,
  IconChevronRight,
  IconLogin,
  IconNote,
  IconPasskey,
  IconPlus,
  IconSearch,
  IconSecret,
  IconShield,
  IconStar,
  IconUpload,
  IconVault,
} from "../components/Icons.js";
import { buildHealthReport } from "../lib/vault/health.js";
import { useVault } from "../lib/vault/hooks.js";
import { stashImportFile } from "../lib/vault/import/handoff.js";
import {
  type Folder,
  type ItemKind,
  KIND_LABEL,
  KIND_PLURAL,
  type VaultItem,
  initialOf,
  itemSubtitle,
  searchMatches,
  sortItems,
} from "../lib/vault/model.js";
import "./vault.css";

const KIND_ORDER: ItemKind[] = [
  "login",
  "passkey",
  "card",
  "secret",
  "note",
  "certificate",
];

const KIND_ICON = {
  login: IconLogin,
  passkey: IconPasskey,
  card: IconCard,
  secret: IconSecret,
  note: IconNote,
  certificate: IconShield,
};

const FILTER_TITLE = new Map([
  ["all", "All items"],
  ["favorites", "Favorites"],
  ["trash", "Trash"],
  ["login", "Logins"],
  ["passkey", "Passkeys"],
  ["card", "Cards"],
  ["secret", "Agent secrets"],
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
function ImportButton() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => fileRef.current?.click()}
      >
        <IconUpload size={16} />
        Import
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

function ItemRow({
  item,
  active,
  search,
}: {
  item: VaultItem;
  active: boolean;
  /** Carried into the detail route so the filter survives a round trip. */
  search: string;
}) {
  const Icon = KIND_ICON[item.kind];
  return (
    <li>
      <Link
        to={`/vault/${item.id}${search}`}
        className={`vault__row${active ? " is-active" : ""}`}
        aria-current={active ? "true" : undefined}
      >
        <span className="vault__avatar" aria-hidden="true">
          {item.kind === "login" || item.kind === "note" ? (
            initialOf(item)
          ) : (
            <Icon size={17} />
          )}
        </span>
        <span className="vault__text">
          <span className="vault__name">{item.name || "Untitled"}</span>
          <span className="vault__sub">{itemSubtitle(item)}</span>
        </span>
        <span className="vault__rowmeta">
          {item.sample ? (
            <span className="chip chip--sample">SYNTHETIC</span>
          ) : null}
          {item.favorite ? (
            <IconStar size={15} filled className="is-fav" title="Favorite" />
          ) : null}
        </span>
      </Link>
    </li>
  );
}

export function VaultSection() {
  const [params] = useSearchParams();
  const location = useLocation();
  const { itemId } = useParams();
  const { items, folders } = useVault();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const filter = params.get("f") ?? "all";
  const folderId = params.get("folder");

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (typing) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        return searchMatches(item, query);
      }),
    );
  }, [items, filter, folderId, query]);

  const detailOpen = location.pathname !== "/vault";
  const title = folderId ? "Folder" : (FILTER_TITLE.get(filter) ?? "All items");

  return (
    <div className="vault" data-pane={detailOpen ? "detail" : "list"}>
      <div className="vault__list">
        <div className="vault__listhead">
          <div className="vault__titlerow">
            <h1>{title}</h1>
            <div className="actions">
              {/* Import sits next to New even with items present — arriving
                  from another manager should not require an empty vault or a
                  hunt through Settings to find it. */}
              <ImportButton />
              <Link className="btn btn--primary btn--sm" to="/vault/new/login">
                <IconPlus size={16} />
                New
              </Link>
            </div>
          </div>
          <div className="vault__search">
            <IconSearch size={17} />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search this vault"
              aria-label="Search vault items"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
            />
            {query ? null : <kbd>/</kbd>}
          </div>
          <MobileFilters
            items={items}
            folders={folders}
            filter={filter}
            folderId={folderId}
          />
          <output className="vault__count">
            {visible.length} {visible.length === 1 ? "item" : "items"}
            {query ? ` matching “${query}”` : ""}
          </output>
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            <span className="empty__mark" aria-hidden="true">
              <IconSearch size={22} />
            </span>
            <h3>{query ? "Nothing matches" : "Nothing here yet"}</h3>
            <p>
              {query
                ? "Search covers names, usernames, URLs, and visible custom fields — not concealed values."
                : filter === "trash"
                  ? "Deleted items wait here until you purge them."
                  : "Human items on this device: logins, passkeys, notes, certificates, and agent secrets. Import a .env or password export, or authorize a Host connector instead."}
            </p>
            {!query && filter !== "trash" ? (
              // On narrow screens the detail pane is not rendered, so this is
              // the only empty state a new arrival sees. It has to offer the
              // import, not just mention it.
              <div className="actions">
                <Link
                  className="btn btn--primary btn--sm"
                  to="/vault/new/login"
                >
                  <IconPlus size={16} />
                  New item
                </Link>
                <ImportButton />
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="vault__rows">
            {visible.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                active={item.id === itemId}
                search={location.search}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="vault__detail">
        <Outlet />
      </div>
    </div>
  );
}

/**
 * The detail pane before anything is selected. Rather than a rack of buttons, it
 * answers the question the list cannot: what is in here, and what needs doing.
 */
export function VaultWelcome() {
  const { items, header } = useVault();
  const live = items.filter((item) => item.deletedAt === null);
  const report = useMemo(() => buildHealthReport(items), [items]);

  if (live.length === 0) {
    return (
      <div className="detail">
        <div className="empty">
          <span className="empty__mark" aria-hidden="true">
            <IconVault size={22} />
          </span>
          <h3>Nothing sealed on this device</h3>
          <p>
            This store is for human items on this machine. Host connectors and
            agent grants live on the Host — they never appear here as secrets.
            Start with a .env import or add a login by hand.
          </p>
          <div className="actions">
            <Link className="btn btn--primary btn--sm" to="/vault/new/login">
              <IconPlus size={16} />
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

  const counts = KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_PLURAL[kind],
    count: live.filter((item) => item.kind === kind).length,
  })).filter((entry) => entry.count > 0);

  const recent = [...live]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 4);

  return (
    <div className="detail">
      <div className="detail__heading">
        <h1>{live.length} items, sealed</h1>
        <p className="hint">
          Decrypted in memory for this session only. Locking discards the key
          {header?.kdf
            ? `; it is re-derived with ${header.kdf.iterations.toLocaleString()} PBKDF2 iterations`
            : header
              ? "; unlock again with an enrolled passkey, PIN, or password"
              : ""}
          .
        </p>
      </div>

      <section className="detail__group">
        <h2 className="detail__grouphead">What is in here</h2>
        <div className="wel__counts">
          {counts.map(({ kind, label, count }) => (
            <Link key={kind} className="wel__count" to={`/vault?f=${kind}`}>
              <span className="wel__countnum">{count}</span>
              <span className="wel__countlabel">{label}</span>
            </Link>
          ))}
        </div>
      </section>

      {report.scored > 0 ? (
        <Link
          className={`wel__health${report.findings.length > 0 ? " is-warn" : " is-ok"}`}
          to="/vault/health"
        >
          <IconShield size={20} />
          <span>
            {report.findings.length === 0
              ? `All ${report.scored} passwords are strong, unique, and current.`
              : `${report.findings.length} of ${report.scored} passwords need attention.`}
          </span>
          <IconChevronRight size={17} />
        </Link>
      ) : null}

      <section className="detail__group">
        <h2 className="detail__grouphead">Recently changed</h2>
        {recent.map((item) => (
          <Link className="wel__recent" key={item.id} to={`/vault/${item.id}`}>
            <span className="wel__recentname">{item.name || "Untitled"}</span>
            <span className="wel__recentmeta">
              {new Date(item.updatedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          </Link>
        ))}
      </section>

      <div className="actions">
        {KIND_ORDER.map((kind) => (
          <Link key={kind} className="btn btn--sm" to={`/vault/new/${kind}`}>
            <IconPlus size={15} />
            {KIND_LABEL[kind]}
          </Link>
        ))}
      </div>
    </div>
  );
}
