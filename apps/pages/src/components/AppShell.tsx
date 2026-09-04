import { overlapCast } from "@opensesame/os-domain";
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
import { SupportSlot } from "../tutorial/ui/SupportLauncher.js";
import { AccountSwitcher } from "./AccountSwitcher.js";
import { ConnectivityBar } from "./ConnectivityBar.js";
import { Crumbs } from "./Crumbs.js";
import {
  IconAuthority,
  IconChevronRight,
  IconConnection,
  IconLock,
  IconMark,
  IconSettings,
  IconUser,
  IconVault,
} from "./Icons.js";
import { KeymapSheet } from "./KeymapSheet.js";
import { NotificationsBar } from "./NotificationsBar.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { Wordmark } from "./Wordmark.js";

const SECTIONS = [
  {
    to: "/vault",
    label: "Vault",
    segment: "vault",
    guide: "nav.vault",
    jump: "v",
    Icon: IconVault,
  },
  {
    to: "/connections",
    label: "Connections",
    segment: "connections",
    guide: "nav.connections",
    jump: "c",
    Icon: IconConnection,
  },
  {
    to: "/access",
    label: "Access",
    segment: "access",
    guide: "nav.access",
    jump: "a",
    Icon: IconAuthority,
  },
  {
    to: "/identity",
    label: "Identity",
    segment: "identity",
    guide: "nav.identity",
    jump: "i",
    Icon: IconUser,
  },
  {
    to: "/settings",
    label: "Settings",
    segment: "settings",
    guide: "nav.settings",
    jump: "s",
    Icon: IconSettings,
  },
] as const;

/** Vault filter views, read as path segments under vault/. */
const KIND_SEGMENTS: Array<{ id: ItemKind; segment: string }> = [
  { id: "login", segment: "logins" },
  { id: "passkey", segment: "passkeys" },
  { id: "card", segment: "cards" },
  { id: "secret", segment: "secrets" },
  { id: "drop", segment: "drops" },
  { id: "note", segment: "notes" },
  { id: "certificate", segment: "certs" },
];

function railRowId(to: string, child = false): string {
  return `rail-${child ? "c" : "s"}-${to.replace(/[^\w]+/g, "-")}`;
}

function TreeRow({
  to,
  isActive,
  child,
  children,
  label,
  end,
  navRef,
  move = true,
  selected = false,
  expanded,
}: {
  to: string;
  isActive?: boolean;
  child?: boolean;
  children: ReactNode;
  label?: string;
  end?: boolean;
  /** Set only on rows the tutorial registry names, so a guide can point here. */
  navRef?: (element: HTMLAnchorElement | null) => void;
  /** Closed directories and every leaf are in the arrow-key walk; an open
   *  directory is not — its children are. */
  move?: boolean;
  selected?: boolean;
  expanded?: boolean;
}) {
  const fixed = isActive !== undefined;
  return (
    <NavLink
      ref={navRef}
      id={railRowId(to, child)}
      to={to}
      end={end}
      role="treeitem"
      tabIndex={-1}
      aria-label={label}
      aria-level={child ? 2 : 1}
      aria-selected={selected}
      aria-expanded={expanded}
      data-rail-move={move ? "" : undefined}
      data-rail-to={to}
      className={
        fixed
          ? `railtree__row${child ? " railtree__row--child" : ""}${isActive ? " is-active" : ""}`
          : ({ isActive: routeActive }) =>
              `railtree__row${child ? " railtree__row--child" : ""}${routeActive ? " is-active" : ""}`
      }
    >
      {/* react-router NavLink children typing vs React 19 ReactNode */}
      {overlapCast(children)}
    </NavLink>
  );
}

/**
 * A section directory in the rail, bound to the semantic target a tutorial
 * names it by (`nav.connections`, never a selector). The rail is instrumented
 * rather than the phone tab bar: the catalog describes these as rail entries,
 * and a target may be bound to exactly one live element.
 */
function SectionRow({
  section,
  open,
  count,
  branch = false,
}: {
  section: (typeof SECTIONS)[number];
  open: boolean;
  count?: number;
  /** True when this directory is open and its children are the walk. */
  branch?: boolean;
}) {
  const ref = useGuideTarget<HTMLAnchorElement>(section.guide);
  return (
    <TreeRow
      to={section.to}
      label={section.label}
      navRef={ref}
      move={!branch}
      selected={!branch && open}
      expanded={open}
    >
      <IconChevronRight
        size={12}
        className={`railtree__caret${open ? " is-open" : ""}`}
      />
      <span className="railtree__name">
        {section.segment}
        <span className="railtree__dim">/</span>
      </span>
      {count !== undefined ? (
        <span className="railtree__count">{count}</span>
      ) : null}
      <kbd className="railtree__jump" title={`Press g then ${section.jump}`}>
        g{section.jump}
      </kbd>
    </TreeRow>
  );
}

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
  const activeFilter = params.get("f") ?? "all";
  const activeFolder = params.get("folder");
  const settingsCategory = settingsCategoryFromLocation(
    location.pathname,
    location.hash,
  );
  const selectedTo = inSettings
    ? settingsPath(settingsCategory)
    : location.pathname === "/vault/health"
      ? "/vault/health"
      : inVault
        ? activeFolder
          ? `/vault?folder=${encodeURIComponent(activeFolder)}`
          : activeFilter === "all"
            ? "/vault"
            : `/vault?f=${activeFilter}`
        : location.pathname.startsWith("/connections")
          ? "/connections"
          : location.pathname.startsWith("/access")
            ? "/access"
            : location.pathname.startsWith("/identity")
              ? "/identity"
              : location.pathname.startsWith("/settings")
                ? "/settings"
                : "/vault";
  currentToRef.current = selectedTo;

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
            activate(candidate);
            return;
          }
        }
      },
      activate: () => {
        const list = rows();
        activate(list[selectedIndex(list)]);
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
        <span className="railtree__count">{count}</span>
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
      aria-activedescendant={railRowId(selectedTo, inVault || inSettings)}
    >
      <SectionRow
        section={SECTIONS[0]}
        open={inVault}
        count={counts.all}
        branch={inVault}
      />
      {inVault ? (
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
          <TreeRow
            to="/vault/health"
            isActive={location.pathname === "/vault/health"}
            selected={selectedTo === "/vault/health"}
            child
          >
            <span className="railtree__name">health</span>
          </TreeRow>
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
      <SectionRow section={SECTIONS[4]} open={inSettings} branch={inSettings} />
      {inSettings ? (
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
 * The session context, as a shell prompt: who@tomb:/ — each segment opens
 * its own switcher. A div, not a paragraph: the switchers render divs, and
 * a <p> may not contain them.
 */
function SessionPrompt() {
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
    </div>
  );
}

function Shell({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const store = useVaultStore();
  // The statusline is the strip that survives every width, so it is the one
  // place a tutorial can point at the lock, the bell, the planes or support
  // and be right on a phone and a desktop alike.
  const connectivityRef = useGuideTarget<HTMLDivElement>("shell.connectivity");
  const notificationsRef = useGuideTarget<HTMLDivElement>(
    "shell.notifications",
  );
  const lockRef = useGuideTarget<HTMLButtonElement>("shell.lock");
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
          <span className="topbar__spacer" />
          <button
            type="button"
            className="icon-btn"
            onClick={store.lock}
            aria-label="Lock vault"
            title="Lock vault"
          >
            <IconLock size={17} />
          </button>
        </header>

        <Crumbs />

        {children}
      </div>

      {/* The workspace statusline: plane truth on the left, notifications and
          the lock on the right — the one strip that is always telling the
          truth about Host and Identity. */}
      <footer className="statusline">
        <SupportSlot />
        <div ref={connectivityRef}>
          <ConnectivityBar />
        </div>
        <span className="statusline__spacer" />
        <div ref={notificationsRef}>
          <NotificationsBar />
        </div>
        <button
          ref={lockRef}
          type="button"
          className="icon-btn"
          onClick={store.lock}
          aria-label="Lock vault"
          title="Lock vault"
        >
          <IconLock size={15} />
        </button>
      </footer>
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
