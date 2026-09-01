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
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import type { ItemKind } from "../lib/vault/model.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { SupportProvider } from "../tutorial/session.js";
import { SupportLauncher } from "../tutorial/ui/SupportLauncher.js";
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

function TreeRow({
  to,
  isActive,
  child,
  children,
  label,
  end,
  navRef,
}: {
  to: string;
  isActive?: boolean;
  child?: boolean;
  children: ReactNode;
  label?: string;
  end?: boolean;
  /** Set only on rows the tutorial registry names, so a guide can point here. */
  navRef?: (element: HTMLAnchorElement | null) => void;
}) {
  const fixed = isActive !== undefined;
  return (
    <NavLink
      ref={navRef}
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
 * A section directory in the rail, bound to the semantic target a tutorial
 * names it by (`nav.connections`, never a selector). The rail is instrumented
 * rather than the phone tab bar: the catalog describes these as rail entries,
 * and a target may be bound to exactly one live element.
 */
function SectionRow({
  section,
  open,
  count,
}: {
  section: (typeof SECTIONS)[number];
  open: boolean;
  count?: number;
}) {
  const ref = useGuideTarget<HTMLAnchorElement>(section.guide);
  return (
    <TreeRow to={section.to} label={section.label} navRef={ref}>
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
      <SectionRow section={SECTIONS[0]} open={inVault} count={counts.all} />
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
      <SectionRow section={SECTIONS[4]} open={inSettings} />
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
          <IconMark size={16} />
          <p className="rail__wordmark">opensesame</p>
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
        <div ref={connectivityRef}>
          <ConnectivityBar />
        </div>
        <span className="statusline__spacer" />
        <div ref={notificationsRef}>
          <NotificationsBar />
        </div>
        <SupportLauncher />
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

/**
 * Support wraps the shell rather than sitting inside it: the panel, the guide
 * runtime and whatever is answering are all one session, and that session ends
 * when the vault locks and this tree unmounts.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  return (
    <SupportProvider>
      <Shell>{children}</Shell>
    </SupportProvider>
  );
}
