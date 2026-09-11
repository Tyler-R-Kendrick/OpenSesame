import { overlapCast } from "@opensesame/os-domain";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
import type { ItemKind } from "../lib/vault/model.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { setRailCursor, useRailCursor } from "./rail-cursor.js";
import {
  IconAuthority,
  IconChevronRight,
  IconConnection,
  IconSettings,
  IconUser,
  IconVault,
} from "./Icons.js";

export const SECTIONS = [
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
export const KIND_SEGMENTS: Array<{ id: ItemKind; segment: string }> = [
  { id: "login", segment: "logins" },
  { id: "passkey", segment: "passkeys" },
  { id: "card", segment: "cards" },
  { id: "secret", segment: "secrets" },
  { id: "drop", segment: "drops" },
  { id: "note", segment: "notes" },
  { id: "certificate", segment: "certs" },
];

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
  end,
  navRef,
  move = true,
  selected = false,
  expanded,
  onToggle,
  selectTo,
  busy,
}: {
  to: string;
  isActive?: boolean;
  child?: boolean;
  level?: number;
  children: ReactNode;
  label?: string;
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
      aria-level={level ?? (child ? 2 : 1)}
      aria-selected={shownSelected}
      aria-expanded={expanded}
      aria-busy={busy}
      onClick={(event) => {
        if (
          !onToggle ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          setRailCursor(null);
          return;
        }
        setRailCursor(event.currentTarget.id);
        event.preventDefault();
        onToggle();
      }}
      data-rail-move={move ? "" : undefined}
      data-rail-to={selectTo ?? to}
      data-rail-preview={selectTo ? "" : undefined}
      className={
        fixed
          ? `railtree__row${child ? " railtree__row--child" : ""}${shownActive(Boolean(isActive)) ? " is-active" : ""}`
          : ({ isActive: routeActive }) =>
              `railtree__row${child ? " railtree__row--child" : ""}${shownActive(routeActive) ? " is-active" : ""}`
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
  section: (typeof SECTIONS)[number];
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
