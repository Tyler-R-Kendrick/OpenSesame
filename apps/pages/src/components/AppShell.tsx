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
import { createKeymapHandler, registerKeymapHelp } from "../lib/keymap.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import type { ItemKind } from "../lib/vault/model.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { AccessTree } from "./AccessTree.js";
import { AccountSwitcher } from "./AccountSwitcher.js";
import { ConnectionsNavigation } from "./ConnectionsNavigation.js";
import { ConnectionsTree } from "./ConnectionsTree.js";
import { Crumbs } from "./Crumbs.js";
import { IconLock, IconMark } from "./Icons.js";
import { IdentityTree } from "./IdentityTree.js";
import { KeymapSheet } from "./KeymapSheet.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { PageTreeLeafRow, useSectionExpand } from "./PageTreeBranch.js";
import { SECTIONS, SectionRow, railRowId } from "./RailRows.js";
import { Statusline } from "./Statusline.js";
import { uniqueFolderKind, VaultRail } from "./VaultRail.js";
import { Wordmark } from "./Wordmark.js";
import { selectedRailPath } from "./rail-path.js";
import { useRailCursor } from "./rail-cursor.js";
import { useRailKeyboard } from "./useRailKeyboard.js";

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
  const vault = useSectionExpand("/vault");
  const connections = useSectionExpand("/connections");
  const access = useSectionExpand("/access");
  const identity = useSectionExpand("/identity");
  const settings = useSectionExpand("/settings");
  const vaultOpen = vault.expanded;
  const settingsOpen = settings.expanded;
  const connectionsOpen = connections.expanded;
  const accessOpen = access.expanded;
  const identityOpen = identity.expanded;
  const activeFilter = params.get("f") ?? "all";
  const activeFolder = params.get("folder");
  const settingsCategory = settingsCategoryFromLocation(
    location.pathname,
    location.hash,
  );
  const selectedTo = selectedRailPath(
    location.pathname,
    location.hash,
    params.get("view"),
    activeFilter,
    activeFolder,
    settingsCategory,
    activeFolder ? uniqueFolderKind(items, activeFolder) : null,
  );
  const section = SECTIONS.find(({ to }) => location.pathname.startsWith(to));
  const sectionOpen = Boolean(
    section &&
      {
        "/vault": vaultOpen,
        "/connections": connectionsOpen,
        "/access": accessOpen,
        "/identity": identityOpen,
        "/settings": settingsOpen,
      }[section.to],
  );
  currentToRef.current = section && !sectionOpen ? section.to : selectedTo;

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

  useRailKeyboard(treeRef, navigateRef, currentToRef);
  const cursorId = useRailCursor();

  return (
    <nav
      ref={treeRef}
      className="railtree"
      aria-label="Sections"
      role="tree"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: role=tree with aria-activedescendant is the interactive element; the tab stop belongs on it
      tabIndex={0}
      aria-activedescendant={
        cursorId ??
        railRowId(currentToRef.current, sectionOpen)
      }
    >
      <SectionRow
        section={SECTIONS[0]}
        open={vaultOpen}
        active={vault.here}
        onToggle={vault.onToggle}
        count={counts.all}
        branch={vaultOpen}
      />
      {vaultOpen ? (
        <VaultRail
          items={items}
          folders={folders}
          counts={counts}
          selectedTo={selectedTo}
        />
      ) : null}

      <ConnectionsTree
        open={connectionsOpen}
        onToggle={connections.onToggle}
      />
      <AccessTree
        open={accessOpen}
        active={access.here}
        onToggle={access.onToggle}
      />
      <IdentityTree
        open={identityOpen}
        active={identity.here}
        onToggle={identity.onToggle}
      />
      <SectionRow
        section={SECTIONS[4]}
        open={settingsOpen}
        active={settings.here}
        branch={settingsOpen}
        onToggle={settings.onToggle}
      />
      {settingsOpen ? (
        <div className="railtree__kids">
          {SETTINGS_CATEGORIES.map((category) => (
            <PageTreeLeafRow
              key={category}
              node={{
                id: category,
                label: category,
                href: settingsPath(category),
                children: [],
                branch: false,
              }}
              level={2}
              current={selectedTo}
            />
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
  return (
    <ConnectionsNavigation>
      <Shell>{children}</Shell>
    </ConnectionsNavigation>
  );
}
