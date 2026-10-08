import type { ItemKindRow } from "@opensesame/app-core/lib/item-kinds.js";
import {
  type Folder,
  type VaultItem,
  itemTypeId,
  listedItems,
} from "@opensesame/vault-core";
/**
 * The rail's section tree, split out of `AppShell` so the shell file stays
 * within the module-size budget (ADR 0093). Nothing about the contract moved:
 * which directories exist is still the plan's business — the core two, plus
 * one per `section` contribution, and nothing for a capability that is not
 * approved (ADR 0130).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { useClaimedDrags } from "../lib/use-claimed-drags.js";
import { useShowHidden } from "../lib/use-show-hidden.js";
import { useVaultAllTo } from "../lib/vault-list-path.js";
import { useVault } from "../lib/vault/hooks.js";
import { IconChevronLeft } from "./Icons.js";
import { nextSectionOpen } from "./PageTreeBranch.js";
import {
  SESSION_SECTIONS,
  SectionRow,
  type SectionRowModel,
  railRowId,
  sectionForPath,
  useSections,
} from "./RailRows.js";
import { SettingsTree } from "./SettingsTree.js";
import { type VaultCounts, VaultRail } from "./VaultRail.js";
import { openContextMenu } from "./context-menu/menu-model.js";
import { railMenu, railRowAt } from "./context-menu/rail-menu.js";
import { useRailCursor, useRailCursorFollowsRoute } from "./rail-cursor.js";
import { useSelectedRail } from "./use-selected-rail.js";
import { useRailKeyboard } from "./useRailKeyboard.js";

import { useVaultDirectories } from "../bindings/contributions.js";
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
      const type = itemTypeId(item);
      byKind.set(type, (byKind.get(type) ?? 0) + 1);
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
  showHidden,
  allTo,
}: {
  section: SectionRowModel;
  expand: SectionExpand;
  pathname: string;
  selectedTo: string;
  counts: VaultCounts;
  items: VaultItem[];
  folders: Folder[];
  kinds: readonly ItemKindRow[];
  showHidden: boolean;
  /** Where the vault's "all items" entry goes — see `VaultRail`. */
  allTo: string;
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
            showHidden={showHidden}
            allTo={allTo}
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
 * The `<` key that returns the tree to the vault view. It carries
 * the vault directory's own row identity — the same id and
 * `data-rail-to` — so a `g v` typed while the tree is rooted
 * elsewhere still lands the keyboard on the vault: the cursor set
 * here is the one the vault's own row wears once the tree returns.
 */
function NavBack() {
  return (
    <NavLink
      to="/vault"
      id={railRowId("/vault")}
      role="treeitem"
      tabIndex={-1}
      aria-level={1}
      aria-label="Back to vault"
      data-rail-move=""
      data-rail-to="/vault"
      data-rail-open="/vault"
      className="railtree__row railtree__back"
    >
      <IconChevronLeft size={12} className="railtree__caret" />
      <span className="railtree__name">
        vault<span className="railtree__dim">/</span>
      </span>
    </NavLink>
  );
}

/**
 * The rail is the filesystem: sections are directories off the tomb root, the
 * active section is the open one, and its views hang under it as entries. The
 * `g`-jump key for each section is advertised on its row. Which directories
 * exist is the plan's business: the core two, plus one per `section`
 * contribution, and nothing for a capability that is not approved.
 */
export function NavTree() {
  const location = useLocation();
  const navigate = useNavigate();
  const { items, folders } = useVault();
  const sections = useSections();
  const kinds = useVaultDirectories(items);
  const showHidden = useShowHidden();
  const allTo = useVaultAllTo();
  const treeRef = useRef<HTMLElement>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const currentToRef = useRef("");
  const expandFor = useSectionExpands(location.pathname, navigate);
  const selectedTo = useSelectedRail(items, kinds, allTo);
  const section = sectionForPath(location.pathname, sections);
  // Settings and the activity log are session-level: the session
  // prompt's menu roots the tree in either one, so neither is a
  // rail directory — the vault view is, and a `<` key returns to it.
  const rerooted =
    section !== undefined && SESSION_SECTIONS.includes(section.to);
  const railSections = useMemo(
    () => sections.filter((entry) => !SESSION_SECTIONS.includes(entry.to)),
    [sections],
  );
  const sectionOpen = Boolean(
    section && isBranch(section) && expandFor(section.to).expanded,
  );
  currentToRef.current = section && !sectionOpen ? section.to : selectedTo;
  const listed = useMemo(() => listedItems(items), [items]);
  const counts = useVaultCounts(listed);

  useClaimedDrags(treeRef);
  useRailKeyboard(treeRef, navigateRef, currentToRef);
  useRailCursorFollowsRoute(
    treeRef,
    location.pathname + location.search + location.hash,
  );
  const cursorId = useRailCursor();

  const tree = (
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
      onContextMenu={(event) => {
        const row = railRowAt(event.target);
        openContextMenu(
          event,
          row ?? event.currentTarget,
          row ? `${row.getAttribute("aria-label") ?? "Entry"} actions` : "Rail",
          railMenu(row, showHidden, navigate),
        );
      }}
    >
      {rerooted && section ? <NavBack /> : null}
      {(rerooted && section ? [section] : railSections).map((entry) => (
        <SectionBranch
          key={entry.to}
          section={entry}
          expand={expandFor(entry.to)}
          pathname={location.pathname}
          selectedTo={selectedTo}
          counts={counts}
          items={listed}
          folders={folders}
          kinds={kinds}
          showHidden={showHidden}
          allTo={allTo}
        />
      ))}
    </nav>
  );
  return tree;
}
