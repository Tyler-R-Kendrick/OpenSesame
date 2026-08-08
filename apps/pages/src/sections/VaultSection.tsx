import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useParams, useSearchParams } from "react-router";
import {
  IconCard,
  IconLogin,
  IconNote,
  IconPasskey,
  IconPlus,
  IconSearch,
  IconSecret,
  IconStar,
} from "../components/Icons.js";
import { useVault } from "../lib/vault/hooks.js";
import {
  initialOf,
  itemSubtitle,
  KIND_LABEL,
  searchMatches,
  sortItems,
  type ItemKind,
  type VaultItem,
} from "../lib/vault/model.js";
import "./vault.css";

const KIND_ICON: Record<ItemKind, typeof IconLogin> = {
  login: IconLogin,
  passkey: IconPasskey,
  card: IconCard,
  secret: IconSecret,
  note: IconNote,
};

const FILTER_TITLE: Record<string, string> = {
  all: "All items",
  favorites: "Favorites",
  trash: "Trash",
  login: "Logins",
  passkey: "Passkeys",
  card: "Cards",
  secret: "Agent secrets",
  note: "Secure notes",
};

function ItemRow({ item, active }: { item: VaultItem; active: boolean }) {
  const Icon = KIND_ICON[item.kind];
  return (
    <li>
      <Link
        to={`/vault/${item.id}`}
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
          {item.sample ? <span className="chip chip--sample">sample</span> : null}
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
  const { items } = useVault();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const filter = params.get("f") ?? "all";
  const folderId = params.get("folder");

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
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
        if (inTrash ? item.deletedAt === null : item.deletedAt !== null) return false;
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
  const title = folderId
    ? "Folder"
    : (FILTER_TITLE[filter] ?? "All items");

  return (
    <div className="vault" data-pane={detailOpen ? "detail" : "list"}>
      <div className="vault__list">
        <div className="vault__listhead">
          <div className="vault__titlerow">
            <h1>{title}</h1>
            <Link className="btn btn--primary btn--sm" to="/vault/new/login">
              <IconPlus size={16} />
              New
            </Link>
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
          <p className="vault__count" role="status">
            {visible.length} {visible.length === 1 ? "item" : "items"}
            {query ? ` matching “${query}”` : ""}
          </p>
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
                  : "Add your first item, or load the sample vault from Settings to see how the pieces fit."}
            </p>
            {!query && filter !== "trash" ? (
              <Link className="btn btn--primary btn--sm" to="/vault/new/login">
                <IconPlus size={16} />
                New item
              </Link>
            ) : null}
          </div>
        ) : (
          <ul className="vault__rows">
            {visible.map((item) => (
              <ItemRow key={item.id} item={item} active={item.id === itemId} />
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

export function VaultWelcome() {
  const { items } = useVault();
  const live = items.filter((item) => item.deletedAt === null);
  return (
    <div className="detail">
      <div className="empty">
        <span className="empty__mark" aria-hidden="true">
          <IconSecret size={22} />
        </span>
        <h3>{live.length > 0 ? "Select an item" : "Your vault is empty"}</h3>
        <p>
          {live.length > 0
            ? "Everything here is decrypted in memory only. Locking the vault discards the key."
            : "Nothing has been stored yet. Items are sealed with AES-256-GCM under a key derived from your master password."}
        </p>
        <div className="actions">
          <Link className="btn btn--primary btn--sm" to="/vault/new/login">
            <IconPlus size={16} />
            New login
          </Link>
          {Object.entries(KIND_LABEL)
            .filter(([kind]) => kind !== "login")
            .map(([kind, label]) => (
              <Link key={kind} className="btn btn--sm" to={`/vault/new/${kind}`}>
                {label}
              </Link>
            ))}
        </div>
      </div>
    </div>
  );
}
