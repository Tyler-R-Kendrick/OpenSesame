import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  IconChevronRight,
  IconClock,
  IconDots,
  IconStar,
} from "../../components/Icons.js";
import { longPress } from "../../lib/gestures.js";
import { registerVaultKeymap, showKeymapHelp } from "../../lib/keymap.js";
import { activeProject } from "../../lib/projects.js";
import type { Folder, VaultItem } from "../../lib/vault/model.js";
import { itemExtension, pathSegment, tombPath } from "../../lib/vault/paths.js";
import { readFile, writeFile } from "../../lib/vfs.js";
import { formatExpiry } from "./DropCeremony.js";

const COLLAPSED_PATH = "config/tree-collapsed";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type VaultTreeActions = {
  open: (item: VaultItem) => void;
  preview: (item: VaultItem) => void;
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
  title: string;
  total: number;
  actions: VaultTreeActions;
  verbs?: ReactNode;
};

type DirRow = {
  type: "dir";
  key: string;
  path: string;
  name: string;
  count: number;
  expanded: boolean;
};

type ItemRow = {
  type: "item";
  key: string;
  path: string;
  name: string;
  ext: string;
  child: boolean;
  item: VaultItem;
};

type TreeRow = DirRow | ItemRow;

async function loadCollapsedDefault(tomb: string): Promise<string[]> {
  try {
    const parsed: BoundaryValue = JSON.parse(
      decoder.decode(await readFile(tomb, COLLAPSED_PATH)),
    );
    if (!Array.isArray(parsed)) return [];
    const collapsed: string[] = [];
    for (const path of parsed) if (isString(path)) collapsed.push(path);
    return collapsed;
  } catch {
    return [];
  }
}

async function saveCollapsedDefault(
  tomb: string,
  paths: string[],
): Promise<void> {
  await writeFile(tomb, COLLAPSED_PATH, encoder.encode(JSON.stringify(paths)));
}

export const vaultTreeSeams = {
  activeTomb: () => activeProject().id,
  loadCollapsed: loadCollapsedDefault,
  saveCollapsed: saveCollapsedDefault,
};

function itemMatches(item: VaultItem, query: string): boolean {
  return `${pathSegment(item.name)}${itemExtension(item)}`
    .toLowerCase()
    .includes(query);
}

function buildRows(
  items: VaultItem[],
  folders: Folder[],
  collapsed: ReadonlySet<string>,
  query: string,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const grouped = new Map<string, VaultItem[]>();
  const rootItems: VaultItem[] = [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  for (const item of items) {
    if (item.folderId && folderIds.has(item.folderId)) {
      const bucket = grouped.get(item.folderId);
      if (bucket) bucket.push(item);
      else grouped.set(item.folderId, [item]);
    } else {
      rootItems.push(item);
    }
  }
  const itemRow = (item: VaultItem, prefix: string): ItemRow => ({
    type: "item",
    key: item.id,
    path: `${prefix}${pathSegment(item.name)}${itemExtension(item)}`,
    name: pathSegment(item.name),
    ext: itemExtension(item),
    child: prefix !== "",
    item,
  });
  // Two folders may share a display name; their paths must not, or their
  // collapse state (persisted by path) and the status line would couple.
  const seenNames = new Map<string, number>();
  for (const folder of folders) {
    const base = pathSegment(folder.name);
    const nth = (seenNames.get(base) ?? 0) + 1;
    seenNames.set(base, nth);
    const name = nth > 1 ? `${base} (${nth})` : base;
    // A query that names the folder keeps the whole directory; otherwise the
    // folder survives only through its matching children.
    const dirHit = query !== "" && name.toLowerCase().includes(query);
    const bucket = grouped.get(folder.id) ?? [];
    const children = dirHit
      ? bucket
      : bucket.filter((item) => !query || itemMatches(item, query));
    if (query && children.length === 0 && !dirHit) continue;
    const path = `${name}/`;
    // A search opens every directory it matched into; outside a search the
    // reader's own collapse choices hold.
    const expanded = query !== "" || !collapsed.has(path);
    rows.push({
      type: "dir",
      key: `dir_${folder.id}`,
      path,
      name,
      count: children.length,
      expanded,
    });
    if (expanded) for (const item of children) rows.push(itemRow(item, path));
  }
  for (const item of rootItems) {
    if (query && !itemMatches(item, query)) continue;
    rows.push(itemRow(item, ""));
  }
  return rows;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

function rowId(key: string): string {
  return `vtree-row-${key}`;
}

function Decorations({ item }: { item: VaultItem }) {
  return (
    <span className="vtree__side">
      {item.kind === "drop" ? (
        <IconClock
          size={13}
          title={`Expires ${formatExpiry(item.expiresAt)}`}
        />
      ) : null}
      {item.favorite ? (
        <IconStar size={13} filled title="Favorite" className="vtree__fav" />
      ) : null}
      {item.sample ? <span className="vtree__syn">SYNTHETIC</span> : null}
    </span>
  );
}

function RowMenu({
  item,
  actions,
  close,
}: {
  item: VaultItem;
  actions: VaultTreeActions;
  close: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && menuRef.current?.contains(target)) return;
      // The ⋯ toggles manage the menu themselves: closing on their
      // pointerdown would race the click, which would reopen the menu it
      // meant to close.
      if (target instanceof Element && target.closest("[data-vtree-more]")) {
        return;
      }
      close();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [close]);
  const entry = (label: string, action: (item: VaultItem) => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={(event) => {
        event.stopPropagation();
        close();
        action(item);
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      ref={menuRef}
      className="vtree__menu"
      role="menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      {entry("Open", actions.open)}
      {entry(item.favorite ? "Unfavorite" : "Favorite", actions.favorite)}
      {item.kind === "secret" ? entry("Share once", actions.share) : null}
      {entry("Edit", actions.edit)}
      {entry("Trash", actions.trash)}
    </div>
  );
}

export function VaultTree({
  items,
  folders,
  activeItemId,
  title,
  total,
  actions,
  verbs,
}: VaultTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const rowsRef = useRef<TreeRow[]>([]);
  const cursorRef = useRef<string | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const persistReadyRef = useRef(false);
  // The keymap effect registers once; these refs hand it the live values.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const setAndSaveCollapsedRef = useRef<(next: ReadonlySet<string>) => void>(
    () => undefined,
  );
  // One collapse-toggle implementation, shared by the once-registered keymap
  // and pointer clicks. It reads only through stable refs.
  const toggleDirRef = useRef((row: DirRow) => {
    const next = new Set(collapsedRef.current);
    if (next.has(row.path)) next.delete(row.path);
    else next.add(row.path);
    setAndSaveCollapsedRef.current(next);
  });

  const tomb = vaultTreeSeams.activeTomb();
  const needle = (query ?? "").trim().toLowerCase();
  const rows = useMemo(
    () => buildRows(items, folders, collapsed, needle),
    [items, folders, collapsed, needle],
  );
  rowsRef.current = rows;
  cursorRef.current = cursor;

  const cursorRow = rows.find((row) => row.key === cursor) ?? null;
  const matchCount = rows.filter((row) => row.type === "item").length;

  useEffect(() => {
    persistReadyRef.current = false;
    let live = true;
    void vaultTreeSeams.loadCollapsed(tomb).then((saved) => {
      if (!live) return;
      setCollapsed(new Set(saved));
      persistReadyRef.current = true;
    });
    return () => {
      live = false;
    };
  }, [tomb]);

  const setAndSaveCollapsed = (next: ReadonlySet<string>) => {
    setCollapsed(next);
    if (persistReadyRef.current) {
      void vaultTreeSeams.saveCollapsed(tomb, [...next]).catch(() => undefined);
    }
  };
  setAndSaveCollapsedRef.current = setAndSaveCollapsed;

  // The open item owns the cursor; without one the cursor holds its row, and
  // falls back to the first row when its row left the tree.
  useEffect(() => {
    if (activeItemId && rows.some((row) => row.key === activeItemId)) {
      setCursor(activeItemId);
      return;
    }
    setCursor((current) =>
      current !== null && rows.some((row) => row.key === current)
        ? current
        : (rows[0]?.key ?? null),
    );
  }, [activeItemId, rows]);

  useEffect(() => {
    if (!cursor) return;
    // The optional call absorbs jsdom, which renders rows without scrolling.
    document
      .getElementById(rowId(cursor))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  useEffect(() => {
    if (query !== null) searchRef.current?.focus();
  }, [query]);

  // Holding a row opens its actions — the touch twin of the ⋯ key, which a
  // finger cannot reveal by hovering.
  useEffect(() => {
    const list = treeRef.current;
    if (!list) return;
    return longPress(list, (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest("[data-vtree-key]");
      if (!(row instanceof HTMLElement)) return;
      const key = row.dataset.vtreeKey;
      if (!key) return;
      const hit = rowsRef.current.find((candidate) => candidate.key === key);
      if (hit?.type !== "item") return;
      setCursor(key);
      setMenuFor(key);
    });
  }, []);

  useEffect(() => {
    const rowAt = (key: string | null) =>
      rowsRef.current.find((row) => row.key === key) ?? null;
    const move = (delta: number) => {
      const list = rowsRef.current;
      if (list.length === 0) return;
      const at = list.findIndex((row) => row.key === cursorRef.current);
      const next =
        at < 0 ? 0 : Math.min(Math.max(at + delta, 0), list.length - 1);
      const row = list[next];
      setCursor(row?.key ?? null);
      // ranger's reading: browsing IS previewing. Only explicit keyboard
      // movement previews, so the initial cursor never yanks the pane.
      if (row?.type === "item") actionsRef.current.preview(row.item);
    };
    const focusedItem = () => {
      const row = rowAt(cursorRef.current);
      return row?.type === "item" ? row.item : null;
    };
    const withItem = (action: (item: VaultItem) => void) => () => {
      const item = focusedItem();
      if (item) action(item);
    };
    const toggleDir = (row: DirRow) => toggleDirRef.current(row);
    return registerVaultKeymap({
      next: () => move(1),
      previous: () => move(-1),
      first: () => move(Number.NEGATIVE_INFINITY),
      last: () => move(Number.POSITIVE_INFINITY),
      enter: () => {
        const row = rowAt(cursorRef.current);
        if (!row) return;
        if (row.type === "item") actionsRef.current.open(row.item);
        else if (row.expanded) move(1);
        else toggleDir(row);
      },
      parent: () => {
        const row = rowAt(cursorRef.current);
        if (!row) return;
        if (row.type === "dir") {
          if (row.expanded) toggleDir(row);
          return;
        }
        if (!row.child) return;
        const list = rowsRef.current;
        for (let at = list.findIndex((r) => r.key === row.key); at >= 0; at--) {
          const candidate = list[at];
          if (candidate?.type === "dir") {
            setCursor(candidate.key);
            return;
          }
        }
      },
      activate: () => {
        const row = rowAt(cursorRef.current);
        if (!row) return;
        if (row.type === "item") actionsRef.current.open(row.item);
        else toggleDir(row);
      },
      search: () => setQuery((current) => current ?? ""),
      closeSearch: () => {
        setQuery(null);
        treeRef.current?.focus();
      },
      copySecret: withItem((item) => actionsRef.current.copySecret(item)),
      copyUsername: withItem((item) => actionsRef.current.copyUsername(item)),
      edit: withItem((item) => actionsRef.current.edit(item)),
      trash: withItem((item) => actionsRef.current.trash(item)),
      create: () => actionsRef.current.create(),
      favorite: withItem((item) => actionsRef.current.favorite(item)),
      share: withItem((item) => actionsRef.current.share(item)),
    });
  }, []);

  const statusPath = tombPath(tomb, cursorRow?.path ?? null);
  const statusMeta =
    query !== null && needle !== ""
      ? `${matchCount}/${total} · /${needle}`
      : `${items.length}/${total} · ${title}`;

  return (
    <div className="vtree">
      <div className="vtree__pathbar">
        <span className="vtree__root">
          <span className="vtree__tomb">{tomb}</span>
          <span className="vtree__sep">:/</span>
        </span>
        <span className="vtree__keys">
          {verbs}
          <button
            type="button"
            className="vtree__key"
            title="Search (/)"
            onClick={() => setQuery((current) => current ?? "")}
          >
            /
          </button>
          <button
            type="button"
            className="vtree__key vtree__key--help"
            title="Keyboard shortcuts (?)"
            onClick={showKeymapHelp}
          >
            ?
          </button>
        </span>
      </div>

      <div
        ref={treeRef}
        className="vtree__rows"
        role="tree"
        aria-label="Vault items"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: role=tree with aria-activedescendant is the interactive element; the tab stop belongs on it
        tabIndex={0}
        aria-activedescendant={cursor ? rowId(cursor) : undefined}
      >
        {rows.map((row) => {
          const isCursor = row.key === cursor;
          const shared = {
            id: rowId(row.key),
            className: `vtree__row${row.type === "item" && row.child ? " vtree__row--child" : ""}${isCursor ? " is-cursor" : ""}`,
            "aria-level": row.type === "item" && row.child ? 2 : 1,
            "aria-selected": isCursor,
          };
          let content: ReactNode;
          if (row.type === "dir") {
            content = (
              <>
                <IconChevronRight
                  size={12}
                  className={`vtree__caret${row.expanded ? " is-open" : ""}`}
                />
                <span className="vtree__name">
                  <Highlight text={row.name} query={needle} />
                  <span className="vtree__dim">/</span>
                </span>
                <span className="vtree__count">{row.count}</span>
              </>
            );
          } else {
            content = (
              <>
                <span className="vtree__name">
                  <Highlight text={row.name} query={needle} />
                  <span className="vtree__dim">{row.ext}</span>
                </span>
                <Decorations item={row.item} />
                <button
                  type="button"
                  className="vtree__more"
                  data-vtree-more=""
                  aria-label={`Actions for ${row.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === row.key}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCursor(row.key);
                    setMenuFor(menuFor === row.key ? null : row.key);
                  }}
                >
                  <IconDots size={14} />
                </button>
                {menuFor === row.key ? (
                  <RowMenu
                    item={row.item}
                    actions={actions}
                    close={() => setMenuFor(null)}
                  />
                ) : null}
              </>
            );
          }
          return (
            <div
              key={row.key}
              role="treeitem"
              data-vtree-key={row.key}
              {...shared}
              {...(row.type === "dir" ? { "aria-expanded": row.expanded } : {})}
              onClick={() => {
                setCursor(row.key);
                if (row.type === "item") actions.open(row.item);
                else toggleDirRef.current(row);
              }}
            >
              {content}
            </div>
          );
        })}
      </div>

      {query !== null ? (
        <div className="vtree__cmd">
          <span className="vtree__prompt" aria-hidden="true">
            /
          </span>
          <input
            ref={searchRef}
            value={query}
            aria-label="Search items"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setQuery(null);
                treeRef.current?.focus();
              } else if (event.key === "Enter") {
                treeRef.current?.focus();
              }
            }}
          />
        </div>
      ) : null}

      <output className="vault__status" aria-live="polite">
        <span className="vault__status-path">{statusPath}</span>
        <span className="vault__status-meta">{statusMeta}</span>
      </output>
    </div>
  );
}
