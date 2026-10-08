import type {
  SectionContribution,
  TreeProps,
} from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { contributionsSnapshot } from "@opensesame/app-core/lib/contributions.js";
import { overlapCast } from "@opensesame/os-domain";
import { type ComponentType, type ReactNode, useMemo } from "react";
import { NavLink } from "react-router";
import { panelFromHash, scrollToPanel } from "../lib/scroll-panel.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import {
  ICONS_BY_NAME,
  IconChevronRight,
  type IconProps,
  IconSettings,
  IconVault,
} from "./Icons.js";
import { setRailCursor, useRailCursor } from "./rail-cursor.js";

/**
 * A row that names a panel already on this page scrolls to it. Its link may
 * be the current address, which navigates nowhere and so never reaches the
 * page's hash effect: the reader still asked to be taken there (PageIndex
 * does the same). A panel on another page is left to that page's arrival.
 */
function landOnPanel(to: string): void {
  const at = to.indexOf("#");
  if (at < 0) return;
  const target = panelFromHash(to.slice(at));
  if (target) scrollToPanel(target);
}

import { useContributions } from "../bindings/contributions.js";
/** One rail directory, whether core or contributed. */
export type SectionRowModel = Readonly<{
  id: string;
  to: string;
  label: string;
  segment: string;
  /** The tutorial target the row is bound to: `nav.<segment>`. */
  guide: string;
  jump: string;
  order: number;
  Icon: ComponentType<IconProps>;
  /**
   * The entries under the row (module contract `TreeProps`: `{ pathname }`).
   * The shell draws the row, keeps its open state and toggles it; absent, the
   * row is a leaf.
   */
  Tree?: ComponentType<TreeProps>;
}>;

/**
 * The directories the core shell always has. Everything else — connections,
 * access, identity, wallet, activity — is a `section` contribution from the
 * capability that owns it, present only while that capability is in the plan.
 */
export const SECTIONS: readonly SectionRowModel[] = [
  {
    id: "vault",
    to: "/vault",
    label: "Vault",
    segment: "vault",
    guide: "nav.vault",
    jump: "v",
    order: 0,
    Icon: IconVault,
  },
  {
    id: "settings",
    to: "/settings",
    label: "Settings",
    segment: "settings",
    guide: "nav.settings",
    jump: "s",
    order: 1000,
    Icon: IconSettings,
  },
];

/**
 * The session-level directories. These are not rail rows: the
 * session prompt's own menu roots the tree in either one, and a
 * `<` key returns to the vault view. Settings is core; the
 * activity log arrives with its module, so a plan without it
 * roots in settings alone.
 */
export const SESSION_SECTIONS = ["/settings", "/activity"];

/** The session-level directories a plan actually has, in rail order. */
export function sessionSections(
  sections: readonly SectionRowModel[] = sectionsSnapshot(),
): readonly SectionRowModel[] {
  return sections.filter((entry) => SESSION_SECTIONS.includes(entry.to));
}

function rowFromContribution(entry: SectionContribution): SectionRowModel {
  return {
    id: entry.id,
    to: entry.to,
    label: entry.label,
    segment: entry.segment,
    guide: `nav.${entry.segment}`,
    jump: entry.jump,
    order: entry.order,
    Icon: ICONS_BY_NAME[entry.icon],
    Tree: entry.Tree,
  };
}

/** Core rows plus the contributed ones, in `order`; a core path wins a clash. */
export function sectionsFrom(
  contributions: readonly SectionContribution[],
): readonly SectionRowModel[] {
  const rows = [
    ...SECTIONS,
    ...contributions
      .filter((entry) => !SECTIONS.some((core) => core.to === entry.to))
      .map(rowFromContribution),
  ];
  return rows.sort((left, right) =>
    left.order !== right.order
      ? left.order - right.order
      : left.id.localeCompare(right.id),
  );
}

export function sectionsSnapshot(): readonly SectionRowModel[] {
  return sectionsFrom(contributionsSnapshot("section"));
}

export function useSections(): readonly SectionRowModel[] {
  const contributions = useContributions("section");
  return useMemo(() => sectionsFrom(contributions), [contributions]);
}

/** The rail directory a pathname lives under, if a registered one. */
export function sectionForPath(
  pathname: string,
  sections: readonly SectionRowModel[] = sectionsSnapshot(),
): SectionRowModel | undefined {
  return sections.find(
    ({ to }) => pathname === to || pathname.startsWith(`${to}/`),
  );
}

export function railRowId(to: string, child = false): string {
  return `rail-${child ? "c" : "s"}-${to.replace(/[^\w]+/g, "-")}`;
}

export function TreeRow({
  to,
  isActive,
  child,
  level,
  children,
  label,
  title,
  end,
  navRef,
  move = true,
  selected = false,
  expanded,
  onToggle,
  selectTo,
  busy,
  kind,
  hidden = false,
  config,
}: {
  to: string;
  isActive?: boolean;
  child?: boolean;
  level?: number;
  children: ReactNode;
  label?: string;
  /** Tooltip. Set when `label` is the longer accessible name. */
  title?: string;
  end?: boolean;
  /** Set only on rows the tutorial registry names, so a guide can point here. */
  navRef?: (element: HTMLAnchorElement | null) => void;
  /** Every row is in the arrow-key walk, including an open directory, so up
   *  from its first child selects the parent instead of a sibling subtree. */
  move?: boolean;
  selected?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  /** Keyboard selection previews this destination; activation follows `to`. */
  selectTo?: string;
  busy?: boolean;
  /** What the context menu treats the row as (`PageTreeLeaf.kind`). */
  kind?: string;
  /** A hidden entry, drawn dim while the rail shows hidden items. */
  hidden?: boolean;
  /** The directory's `config.yaml`, which its context menu can open. */
  config?: string;
}) {
  const fixed = isActive !== undefined;
  const id = railRowId(selectTo ?? to, child);
  const cursor = useRailCursor();
  const onCursor = cursor !== null && cursor === id;
  const shownSelected = cursor !== null ? onCursor : selected;
  const shownActive = (routeActive: boolean) =>
    cursor !== null ? onCursor : fixed ? Boolean(isActive) : routeActive;
  return (
    <NavLink
      ref={navRef}
      id={id}
      to={to}
      end={end}
      role="treeitem"
      tabIndex={-1}
      aria-label={label}
      title={title}
      aria-level={level ?? (child ? 2 : 1)}
      aria-selected={shownSelected}
      aria-expanded={expanded}
      aria-busy={busy}
      data-rail-toggle={onToggle ? "true" : undefined}
      onClick={(event) => {
        const modified =
          event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
        if (!modified) landOnPanel(to);
        if (!onToggle) {
          setRailCursor(null);
          return;
        }
        if (modified) return;
        setRailCursor(event.currentTarget.id);
        event.preventDefault();
        onToggle();
      }}
      data-rail-move={move ? "" : undefined}
      data-rail-to={selectTo ?? to}
      data-rail-open={to}
      data-rail-preview={selectTo ? "" : undefined}
      data-rail-kind={kind}
      data-rail-hidden={hidden ? "" : undefined}
      data-rail-config={config}
      className={({ isActive: routeActive }) =>
        `railtree__row${child ? " railtree__row--child" : ""}${hidden ? " railtree__row--hidden" : ""}${shownActive(fixed ? Boolean(isActive) : routeActive) ? " is-active" : ""}`
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
export function SectionRow({
  section,
  open,
  count,
  branch = false,
  active = open,
  onToggle,
}: {
  section: SectionRowModel;
  open: boolean;
  count?: number;
  /** True when this directory is open. */
  branch?: boolean;
  active?: boolean;
  onToggle?: () => void;
}) {
  const ref = useGuideTarget<HTMLAnchorElement>(section.guide);
  return (
    <TreeRow
      to={section.to}
      label={section.label}
      navRef={ref}
      selected={!branch && active}
      isActive={active}
      expanded={onToggle ? open : undefined}
      onToggle={onToggle}
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
        <span className="railtree__count">{count || "-"}</span>
      ) : null}
      <kbd className="railtree__jump" title={`Press g then ${section.jump}`}>
        g{section.jump}
      </kbd>
    </TreeRow>
  );
}
