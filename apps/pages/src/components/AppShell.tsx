import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { settingsCategoryFromLocation } from "../lib/crumbs.js";
import { keyboardIsIdle, landFocus } from "../lib/focus.js";
import { type ItemKindRow, useItemKinds } from "../lib/item-kinds.js";
import {
  createKeymapHandler,
  focusVaultListing,
  registerKeymapHelp,
} from "../lib/keymap.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import type { Folder, VaultItem } from "../lib/vault/model.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { AccountSwitcher } from "./AccountSwitcher.js";
import { Crumbs } from "./Crumbs.js";
import { IconLock } from "./Icons.js";
import { InstallMark } from "./InstallMark.js";
import { KeymapSheet } from "./KeymapSheet.js";
import { MoreMenu } from "./MoreMenu.js";
import { NavDrawer } from "./NavDrawer.js";
import { nextSectionOpen } from "./PageTreeBranch.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import {
  type SectionRowModel,
  SectionRow,
  railRowId,
  sectionForPath,
  useSections,
} from "./RailRows.js";
import { SettingsTree } from "./SettingsTree.js";
import { Statusline } from "./Statusline.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { type VaultCounts, VaultRail, uniqueFolderKind } from "./VaultRail.js";
import { Wordmark } from "./Wordmark.js";
import { useRailCursor } from "./rail-cursor.js";
import { selectedRailPath } from "./rail-path.js";
import { useRailKeyboard } from "./useRailKeyboard.js";

type SectionExpand = {
  expanded: boolean;
  here: boolean;
  onToggle: () => void;
};

/**
 * Open state for every section directory, keyed by path. Sections arrive and
 * leave with the plan, so this is one map rather than one hook per section;
 * a directory starts open when the shell mounted on it, the way
 * `useSectionExpand` seeds a single row.
 */
function useSectionExpands(
  pathname: string,
  navigate: (to: string) => void,
): (to: string) => SectionExpand {
  const mountedAt = useRef(pathname);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return useCallback(
    (to: string) => {
      const here = pathname.startsWith(to);
      const expanded = open[to] ?? mountedAt.current.startsWith(to);
      return {
        expanded,
        here,
        onToggle: () => {
          if (nextSectionOpen(here, expanded) !== expanded) {
            setOpen((state) => ({ ...state, [to]: !expanded }));
          }
          if (!here) navigate(to);
        },
      };
    },
    [open, pathname, navigate],
  );
}

function useVaultCounts(items: VaultItem[]): VaultCounts {
  return useMemo(() => {
    const live = items.filter((item) => item.deletedAt === null);
    const byKind = new Map<string, number>();
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
}

/** Whether a section has entries under it, so its row can open at all. */
function isBranch(section: SectionRowModel): boolean {
  return (
    section.to === "/vault" ||
    section.to === "/settings" ||
    section.Tree !== undefined
  );
}

/**
 * One rail directory. The two core ones draw the vault's filters and the
 * settings tabs; a contributed section's row is drawn here too, with the
 * entries its module supplied as `Tree` beneath it when open, or as a plain
 * leaf when it has none.
 */
function SectionBranch({
  section,
  expand,
  pathname,
  selectedTo,
  counts,
  items,
  folders,
  kinds,
}: {
  section: SectionRowModel;
  expand: SectionExpand;
  pathname: string;
  selectedTo: string;
  counts: VaultCounts;
  items: VaultItem[];
  folders: Folder[];
  kinds: readonly ItemKindRow[];
}) {
  const { expanded, here, onToggle } = expand;
  if (section.to === "/vault") {
    return (
      <>
        <SectionRow
          section={section}
          open={expanded}
          active={here}
          onToggle={onToggle}
          count={counts.all}
          branch={expanded}
        />
        {expanded ? (
          <VaultRail
            items={items}
            folders={folders}
            counts={counts}
            selectedTo={selectedTo}
            kinds={kinds}
          />
        ) : null}
      </>
    );
  }
  if (section.to === "/settings") {
    return (
      <>
        <SectionRow
          section={section}
          open={expanded}
          active={here}
          branch={expanded}
          onToggle={onToggle}
        />
        {expanded ? <SettingsTree current={selectedTo} /> : null}
      </>
    );
  }
  const Tree = section.Tree;
  if (Tree) {
    return (
      <>
        <SectionRow
          section={section}
          open={expanded}
          active={here}
          branch={expanded}
          onToggle={onToggle}
        />
        {expanded ? <Tree pathname={pathname} /> : null}
      </>
    );
  }
  return (
    <SectionRow
      section={section}
      open={false}
      active={pathname.startsWith(section.to)}
    />
  );
}

/**
 * The rail is the filesystem: sections are directories off the tomb root, the
 * active section is the open one, and its views hang under it as entries. The
 * `g`-jump key for each section is advertised on its row. Which directories
 * exist is the plan's business: the core two, plus one per `section`
 * contribution, and nothing for a capability that is not approved.
 */
function NavTree() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { items, folders } = useVault();
  const sections = useSections();
  const kinds = useItemKinds();
  const treeRef = useRef<HTMLElement>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const currentToRef = useRef("");
  const expandFor = useSectionExpands(location.pathname, navigate);
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
    activeFolder ? uniqueFolderKind(items, activeFolder, kinds) : null,
  );
  const section = sectionForPath(location.pathname, sections);
  const sectionOpen = Boolean(
    section && isBranch(section) && expandFor(section.to).expanded,
  );
  currentToRef.current = section && !sectionOpen ? section.to : selectedTo;
  const counts = useVaultCounts(items);

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
        cursorId ?? railRowId(currentToRef.current, sectionOpen)
      }
    >
      {sections.map((entry) => (
        <SectionBranch
          key={entry.to}
          section={entry}
          expand={expandFor(entry.to)}
          pathname={location.pathname}
          selectedTo={selectedTo}
          counts={counts}
          items={items}
          folders={folders}
          kinds={kinds}
        />
      ))}
    </nav>
  );
}

/**
 * A capability removed while its route is current leaves the person on a
 * screen that no longer exists (SURFACE-09). The shell returns to the vault
 * and lands the keyboard there, rather than on a blank pane or on `body`.
 * A cold load of an unregistered path is not this case: no section was ever
 * matched, and the router's own fallback answers it.
 */
function useDeniedRouteFallback(sections: readonly SectionRowModel[]) {
  const location = useLocation();
  const navigate = useNavigate();
  const matchedBefore = useRef(false);
  const landing = useRef(false);
  useEffect(() => {
    const matched = sectionForPath(location.pathname, sections) !== undefined;
    if (matchedBefore.current && !matched) {
      landing.current = true;
      navigate("/vault", { replace: true });
    }
    matchedBefore.current = matched;
  }, [sections, location.pathname, navigate]);
  useEffect(() => {
    if (!landing.current || location.pathname !== "/vault") return;
    landing.current = false;
    focusVaultListing();
    if (keyboardIsIdle()) landFocus(document.getElementById("main"));
  }, [location.pathname]);
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
        onClick={() => store.lock()}
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
  useDeniedRouteFallback(useSections());
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
          <InstallMark />
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
          {/* Sections at the leading edge, where a drawer's key belongs; plane
              truth, notifications, help and the keymap at the trailing one.
              Between them the bar a phone already had is the whole chrome. */}
          <NavDrawer />
          <SessionPrompt />
          <InstallMark />
          <ThemeToggle />
          <MoreMenu />
        </header>

        <Crumbs />

        {children}
      </div>

      <Statusline />

      <KeymapSheet open={keymapOpen} close={closeKeymap} />
    </div>
  );
}

/**
 * Unlocked chrome. Support is mounted at the app root, not here, and so is
 * every optional section's own state: the connectors module wraps its route
 * and tree in `ConnectionsNavigation` itself, so the shell imports nothing a
 * plan may have excluded.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  return <Shell>{children}</Shell>;
}
