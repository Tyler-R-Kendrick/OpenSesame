import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  NavLink,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import {
  SETTINGS_CATEGORIES,
  type SettingsCategory,
  settingsCategoryFromLocation,
  settingsPath,
} from "../lib/crumbs.js";
import {
  createKeymapHandler,
  focusVaultListing,
  registerKeymapHelp,
  registerRailKeymap,
} from "../lib/keymap.js";
import { pageSteps, viewportIndex } from "../lib/tree-motion.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import type { ItemKind } from "../lib/vault/model.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { AccountSwitcher } from "./AccountSwitcher.js";
import { Crumbs } from "./Crumbs.js";
import { IconLock, IconMark } from "./Icons.js";
import { KeymapSheet } from "./KeymapSheet.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import {
  KIND_SEGMENTS,
  SECTIONS,
  SectionRow,
  TreeRow,
  railRowId,
} from "./RailRows.js";
import { Statusline } from "./Statusline.js";
import { Wordmark } from "./Wordmark.js";

/**
 * The same destination as its rail row, and bound to the same semantic target.
 * Only one of the two is visible at any width, so the registry holds both as
 * candidates and resolves to whichever can actually be pointed at — otherwise
 * every navigation guide would fail closed on one form factor.
 */
function TabRow({ section }: { section: (typeof SECTIONS)[number] }) {
  const ref = useGuideTarget<HTMLAnchorElement>(section.guide);
  const { to, label, Icon } = section;
  return (
    <NavLink
      ref={ref}
      to={to}
      className={({ isActive }) =>
        `tabbar__link${isActive ? " is-active" : ""}`
      }
    >
      <Icon size={20} />
      <span>{label}</span>
    </NavLink>
  );
}

/**
 * The rail is the filesystem: sections are directories off the tomb root, the
 * active section is the open one, and its views hang under it as entries. The
 * `g`-jump key for each section is advertised on its row.
 */
function selectedRailPath(
  pathname: string,
  filter: string,
  folder: string | null,
  category: SettingsCategory,
): string {
  if (pathname.startsWith("/settings")) return settingsPath(category);
  if (pathname.startsWith("/vault")) {
    if (folder) return `/vault?folder=${encodeURIComponent(folder)}`;
    return filter === "all" ? "/vault" : `/vault?f=${filter}`;
  }
  return SECTIONS.find(({ to }) => pathname.startsWith(to))?.to ?? "/vault";
}

function NavTree() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { items, folders } = useVault();
  const treeRef = useRef<HTMLElement>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const currentToRef = useRef("");
  const inVault = location.pathname.startsWith("/vault");
  const inSettings = location.pathname.startsWith("/settings");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const vaultOpen = inVault && !collapsed.has("/vault");
  const settingsOpen = inSettings && !collapsed.has("/settings");
  const toggleSection = (to: string, active: boolean) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (active && !next.has(to)) next.add(to);
      else next.delete(to);
      return next;
    });
    if (!active) navigate(to);
  };
  const activeFilter = params.get("f") ?? "all";
  const activeFolder = params.get("folder");
  const settingsCategory = settingsCategoryFromLocation(
    location.pathname,
    location.hash,
  );
  const selectedTo = selectedRailPath(
    location.pathname,
    activeFilter,
    activeFolder,
    settingsCategory,
  );
  currentToRef.current =
    inVault && !vaultOpen
      ? "/vault"
      : inSettings && !settingsOpen
        ? "/settings"
        : selectedTo;

  const counts = useMemo(() => {
    const live = items.filter((item) => item.deletedAt === null);
    const byKind = new Map<ItemKind, number>();
    const byFolder = new Map<string, number>();
    for (const item of live) {
      byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
      if (item.folderId) {
        byFolder.set(item.folderId, (byFolder.get(item.folderId) ?? 0) + 1);
      }
    }
    return {
      all: live.length,
      favorites: live.filter((item) => item.favorite).length,
      trash: items.length - live.length,
      byKind,
      byFolder,
    };
  }, [items]);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const rows = () => [
      ...tree.querySelectorAll<HTMLAnchorElement>("[data-rail-move]"),
    ];
    const allRows = () => [
      ...tree.querySelectorAll<HTMLAnchorElement>("a.railtree__row"),
    ];
    const selectedIndex = (list: HTMLAnchorElement[]) => {
      const to = currentToRef.current;
      const byTo = list.findIndex((row) => row.dataset.railTo === to);
      if (byTo >= 0) return byTo;
      const selected = list.findIndex(
        (row) => row.getAttribute("aria-selected") === "true",
      );
      return selected >= 0
        ? selected
        : list.findIndex((row) => row.classList.contains("is-active"));
    };
    const activate = (row: HTMLAnchorElement | undefined) => {
      if (!row) return;
      const to = row.dataset.railTo;
      if (to) {
        currentToRef.current = to;
        navigateRef.current(to);
      }
      tree.focus({ preventScroll: true });
      row.scrollIntoView?.({ block: "nearest" });
    };
    const move = (delta: number) => {
      const list = rows();
      if (list.length === 0) return;
      const at = selectedIndex(list);
      const next =
        at < 0 ? 0 : Math.min(Math.max(at + delta, 0), list.length - 1);
      activate(list[next]);
    };
    const dive = (row: HTMLAnchorElement) => {
      activate(row);
      if ((row.dataset.railTo ?? "").startsWith("/vault")) {
        focusVaultListing();
      }
    };
    return registerRailKeymap({
      next: (n = 1) => move(n),
      previous: (n = 1) => move(-n),
      first: () => move(Number.NEGATIVE_INFINITY),
      last: () => move(Number.POSITIVE_INFINITY),
      page: (direction, size) => {
        const scroller = tree.closest<HTMLElement>(".rail__scroll");
        move(direction * pageSteps(scroller, size === "half"));
      },
      edge: (where) => {
        const list = rows();
        const scroller = tree.closest<HTMLElement>(".rail__scroll");
        const index = viewportIndex(scroller, list, where);
        if (index >= 0) activate(list[index]);
      },
      focus: () => {
        tree.focus({ preventScroll: true });
      },
      toIndex: (index) => {
        const list = rows();
        if (list.length === 0) return;
        const next = Math.min(Math.max(index, 0), list.length - 1);
        activate(list[next]);
      },
      enter: () => {
        const list = rows();
        const at = selectedIndex(list);
        const row = list[at];
        if (!row) return;
        if (row.getAttribute("aria-expanded") === "false") {
          row.click();
          return;
        }
        const kids = row.nextElementSibling;
        if (
          kids instanceof HTMLElement &&
          kids.classList.contains("railtree__kids")
        ) {
          const first =
            kids.querySelector<HTMLAnchorElement>("a.railtree__row");
          dive(first ?? row);
          return;
        }
        dive(row);
      },
      parent: () => {
        const movable = rows();
        const current = movable[selectedIndex(movable)];
        if (!current?.classList.contains("railtree__row--child")) return;
        const all = allRows();
        const from = all.indexOf(current);
        for (let at = from - 1; at >= 0; at--) {
          const candidate = all[at];
          if (
            candidate &&
            !candidate.classList.contains("railtree__row--child")
          ) {
            candidate.click();
            tree.focus({ preventScroll: true });
            return;
          }
        }
      },
      activate: () => {
        const list = rows();
        const row = list[selectedIndex(list)];
        if (row?.hasAttribute("aria-expanded")) row.click();
        else activate(row);
      },
    });
  }, []);

  const entry = (
    query: string,
    isActive: boolean,
    segment: string,
    count?: number,
    dir = false,
  ) => (
    <TreeRow
      key={query || "all"}
      to={`/vault${query}`}
      isActive={isActive}
      selected={`/vault${query}` === selectedTo}
      child
      end
    >
      <span className="railtree__name">
        {segment}
        {dir ? <span className="railtree__dim">/</span> : null}
      </span>
      {count !== undefined ? (
        <span className="railtree__count">{count || "-"}</span>
      ) : null}
    </TreeRow>
  );

  return (
    <nav
      ref={treeRef}
      className="railtree"
      aria-label="Sections"
      role="tree"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: role=tree with aria-activedescendant is the interactive element; the tab stop belongs on it
      tabIndex={0}
      aria-activedescendant={railRowId(
        currentToRef.current,
        vaultOpen || settingsOpen,
      )}
    >
      <SectionRow
        section={SECTIONS[0]}
        open={vaultOpen}
        active={inVault}
        onToggle={() => toggleSection("/vault", inVault)}
        count={counts.all}
        branch={vaultOpen}
      />
      {vaultOpen ? (
        <div className="railtree__kids">
          {entry(
            "",
            activeFilter === "all" && !activeFolder,
            "all",
            counts.all,
          )}
          {entry(
            "?f=favorites",
            activeFilter === "favorites",
            "favorites",
            counts.favorites,
          )}
          {KIND_SEGMENTS.map(({ id, segment }) =>
            entry(
              `?f=${id}`,
              activeFilter === id,
              segment,
              counts.byKind.get(id) ?? 0,
            ),
          )}
          {entry("?f=trash", activeFilter === "trash", "trash", counts.trash)}
          {folders.map((folder) =>
            entry(
              `?folder=${encodeURIComponent(folder.id)}`,
              activeFolder === folder.id,
              folder.name,
              counts.byFolder.get(folder.id) ?? 0,
              true,
            ),
          )}
        </div>
      ) : null}

      <SectionRow
        section={SECTIONS[1]}
        open={location.pathname.startsWith("/connections")}
      />
      <SectionRow
        section={SECTIONS[2]}
        open={location.pathname.startsWith("/access")}
      />
      <SectionRow
        section={SECTIONS[3]}
        open={location.pathname.startsWith("/identity")}
      />
      <SectionRow
        section={SECTIONS[4]}
        open={settingsOpen}
        active={inSettings}
        branch={settingsOpen}
        onToggle={() => toggleSection("/settings", inSettings)}
      />
      {settingsOpen ? (
        <div className="railtree__kids">
          {SETTINGS_CATEGORIES.map((category) => (
            <TreeRow
              key={category}
              to={settingsPath(category)}
              isActive={settingsCategory === category}
              selected={settingsCategory === category}
              child
            >
              <span className="railtree__name">{category}</span>
            </TreeRow>
          ))}
        </div>
      ) : null}
    </nav>
  );
}

/**
 * Account, vault switcher, and lock share one session prompt at every width.
 */
function SessionPrompt() {
  const store = useVaultStore();
  const lockRef = useGuideTarget<HTMLButtonElement>("shell.lock");
  return (
    <div className="rail__prompt">
      <AccountSwitcher />
      <span className="prompt__dim" aria-hidden="true">
        @
      </span>
      <ProjectSwitcher />
      <span className="prompt__dim" aria-hidden="true">
        :/
      </span>
      <button
        ref={lockRef}
        type="button"
        className="icon-btn"
        onClick={store.lock}
        aria-label="Lock vault"
        title="Lock vault"
      >
        <IconLock size={17} />
      </button>
    </div>
  );
}

function Shell({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const [keymapOpen, setKeymapOpen] = useState(false);
  const showKeymap = useCallback(() => setKeymapOpen(true), []);
  const closeKeymap = useCallback(() => setKeymapOpen(false), []);
  const keymap = useMemo(
    () => createKeymapHandler({ navigate, showHelp: showKeymap }),
    [navigate, showKeymap],
  );

  useEffect(() => {
    window.addEventListener("keydown", keymap, true);
    return () => window.removeEventListener("keydown", keymap, true);
  }, [keymap]);

  useEffect(() => registerKeymapHelp(showKeymap), [showKeymap]);

  return (
    <div className="app">
      <a href="#main" className="skip-link visually-hidden">
        Skip to content
      </a>
      <aside className="rail">
        <div className="rail__brand">
          <Wordmark className="rail__wordmark" />
        </div>

        <SessionPrompt />

        <div className="rail__scroll">
          <NavTree />
        </div>
      </aside>

      <div className="main">
        {/* Phone chrome only: on a desktop the rail carries identity and the
            statusline carries plane truth, so the top bar exists where the
            rail is gone. */}
        <header className="topbar">
          <IconMark size={16} />
          <SessionPrompt />
        </header>

        <Crumbs />

        {children}
      </div>

      <Statusline />
      <nav className="tabbar" aria-label="Sections">
        {SECTIONS.map((section) => (
          <TabRow key={section.to} section={section} />
        ))}
      </nav>

      <KeymapSheet open={keymapOpen} close={closeKeymap} />
    </div>
  );
}

/** Unlocked chrome. Support is mounted at the app root, not here. */
export function AppShell({ children }: { children?: ReactNode }) {
  return <Shell>{children}</Shell>;
}
