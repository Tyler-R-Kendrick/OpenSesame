import { overlapCast } from "@opensesame/os-domain";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
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
import { createKeymapHandler, registerKeymapHelp } from "../lib/keymap.js";
import { activeProject } from "../lib/projects.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import type { ItemKind } from "../lib/vault/model.js";
import { AccountSwitcher } from "./AccountSwitcher.js";
import { ConnectivityBar } from "./ConnectivityBar.js";
import { Crumbs } from "./Crumbs.js";
import {
  IconAuthority,
  IconChevronRight,
  IconConnection,
  IconSettings,
  IconUser,
  IconVault,
} from "./Icons.js";
import { KeymapSheet } from "./KeymapSheet.js";
import { NotificationsBar } from "./NotificationsBar.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";

const SECTIONS = [
  {
    to: "/vault",
    label: "Vault",
    segment: "vault",
    jump: "v",
    Icon: IconVault,
  },
  {
    to: "/connections",
    label: "Connections",
    segment: "connections",
    jump: "c",
    Icon: IconConnection,
  },
  {
    to: "/access",
    label: "Access",
    segment: "access",
    jump: "a",
    Icon: IconAuthority,
  },
  {
    to: "/identity",
    label: "Identity",
    segment: "identity",
    jump: "i",
    Icon: IconUser,
  },
  {
    to: "/settings",
    label: "Settings",
    segment: "settings",
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

function TreeRow({
  to,
  isActive,
  child,
  children,
  label,
  end,
}: {
  to: string;
  isActive?: boolean;
  child?: boolean;
  children: ReactNode;
  label?: string;
  end?: boolean;
}) {
  const fixed = isActive !== undefined;
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
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
 * The rail is the filesystem: sections are directories off the tomb root, the
 * active section is the open one, and its views hang under it as entries. The
 * `g`-jump key for each section is advertised on its row.
 */
function NavTree() {
  const location = useLocation();
  const [params] = useSearchParams();
  const { items, folders } = useVault();
  const inVault = location.pathname.startsWith("/vault");
  const inSettings = location.pathname.startsWith("/settings");
  const activeFilter = params.get("f") ?? "all";
  const activeFolder = params.get("folder");
  const settingsCategory = settingsCategoryFromLocation(
    location.pathname,
    location.hash,
  );

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

  const dirRow = (
    section: (typeof SECTIONS)[number],
    open: boolean,
    count?: number,
  ) => (
    <TreeRow key={section.to} to={section.to} label={section.label}>
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
    <nav className="railtree" aria-label="Sections">
      <p className="railtree__root">
        <span className="railtree__tomb">{activeProject().id}</span>
        <span className="railtree__dim">:/</span>
      </p>

      {dirRow(SECTIONS[0], inVault, counts.all)}
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
            child
          >
            <span className="railtree__name">health</span>
          </TreeRow>
        </div>
      ) : null}

      {dirRow(SECTIONS[1], location.pathname.startsWith("/connections"))}
      {dirRow(SECTIONS[2], location.pathname.startsWith("/access"))}
      {dirRow(SECTIONS[3], location.pathname.startsWith("/identity"))}
      {dirRow(SECTIONS[4], inSettings)}
      {inSettings ? (
        <div className="railtree__kids">
          {SETTINGS_CATEGORIES.map((category) => (
            <TreeRow
              key={category}
              to={settingsPath(category)}
              isActive={settingsCategory === category}
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

export function AppShell({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const store = useVaultStore();
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
          <span className="mark" aria-hidden="true">
            <IconVault size={17} />
          </span>
          <div>
            <p className="rail__wordmark">OpenSesame</p>
            <p className="rail__tagline">Authorization fabric</p>
          </div>
        </div>

        <AccountSwitcher />
        <ProjectSwitcher />

        <div className="rail__scroll">
          <NavTree />
        </div>
      </aside>

      <div className="main">
        {/* Phone chrome only: on a desktop the rail carries identity and the
            statusline carries plane truth, so the top bar exists where the
            rail is gone. */}
        <header className="topbar">
          <span className="mark" aria-hidden="true">
            <IconVault size={17} />
          </span>
          <AccountSwitcher />
          <ProjectSwitcher />
          <span className="topbar__spacer" />
          <NotificationsBar />
          <ConnectivityBar />
          <span className="topbar__rule" aria-hidden="true" />
          <button type="button" className="rail__lock" onClick={store.lock}>
            Lock
          </button>
        </header>

        <Crumbs />

        {children}

        <nav className="tabbar" aria-label="Sections">
          {SECTIONS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `tabbar__link${isActive ? " is-active" : ""}`
              }
            >
              <Icon size={20} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>

      {/* The workspace statusline: plane truth on the left, notifications and
          the lock on the right — the one strip that is always telling the
          truth about Host and Identity. */}
      <footer className="statusline">
        <ConnectivityBar />
        <span className="statusline__spacer" />
        <NotificationsBar />
        <button type="button" className="rail__lock" onClick={store.lock}>
          Lock
        </button>
      </footer>
      <KeymapSheet open={keymapOpen} close={closeKeymap} />
    </div>
  );
}
