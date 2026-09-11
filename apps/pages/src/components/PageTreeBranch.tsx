import { type ReactNode, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { PageTreeNode } from "../lib/page-to-tree.js";
import { IconChevronRight } from "./Icons.js";
import { TreeRow } from "./RailRows.js";

/**
 * Subtrees start closed. Right/click opens, Left/click closes. Arriving on
 * the row via up/down or the URL must not open it.
 */
export function useBranchExpand(initial = false) {
  const [expanded, setExpanded] = useState(initial);
  return {
    expanded,
    toggle: () => setExpanded((open) => !open),
  };
}

/** Clicking the current section flips it; clicking another only opens it. */
export function nextSectionOpen(here: boolean, expanded: boolean): boolean {
  return here ? !expanded : true;
}

export function useSectionExpand(to: string) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const here = pathname.startsWith(to);
  const { expanded, toggle } = useBranchExpand(here);
  return {
    expanded,
    here,
    onToggle: () => {
      if (nextSectionOpen(here, expanded) !== expanded) toggle();
      if (!here) navigate(to);
    },
  };
}

export function rowSelected(
  current: string,
  node: { href: string; selectTo?: string },
) {
  return current === node.href || current === node.selectTo;
}

function BranchCaret({ open }: { open: boolean }) {
  return (
    <IconChevronRight
      size={12}
      className={`railtree__caret${open ? " is-open" : ""}`}
    />
  );
}

export function PageTreeLeafRow({
  node,
  level,
  current,
}: {
  node: PageTreeNode;
  level: number;
  current: string;
}) {
  const selected = rowSelected(current, node);
  return (
    <TreeRow
      child
      level={level}
      to={node.href}
      label={node.label}
      selectTo={node.selectTo}
      selected={selected}
      isActive={selected}
    >
      <span className="railtree__name">
        {node.label}
        {node.dir ? <span className="railtree__dim">/</span> : null}
      </span>
      {node.count !== undefined ? (
        <span className="railtree__count">{node.count || "-"}</span>
      ) : null}
    </TreeRow>
  );
}

/** A page-derived directory: left/right collapse and expand this row. */
export function PageTreeBranch({
  node,
  level,
  current,
  children,
  empty,
}: {
  node: PageTreeNode;
  level: number;
  current: string;
  children?: ReactNode;
  empty?: ReactNode;
}) {
  const navigate = useNavigate();
  const { expanded, toggle } = useBranchExpand();
  const selected = rowSelected(current, node);
  const shown = node.count ?? (node.children.length || "-");
  return (
    <>
      <TreeRow
        child
        level={level}
        to={node.href}
        label={node.label}
        expanded={expanded}
        selected={selected}
        isActive={selected}
        onToggle={() => {
          toggle();
          navigate(node.href);
        }}
      >
        <BranchCaret open={expanded} />
        <span className="railtree__name">{node.label}</span>
        <span className="railtree__count">{shown || "-"}</span>
      </TreeRow>
      {expanded ? (
        <div className="railtree__kids" id={`${node.id}-tree`}>
          {children ??
            node.children.map((child) =>
              child.branch ? (
                <PageTreeBranch
                  key={child.id}
                  node={child}
                  level={level + 1}
                  current={current}
                />
              ) : (
                <PageTreeLeafRow
                  key={child.id}
                  node={child}
                  level={level + 1}
                  current={current}
                />
              ),
            )}
          {!children && node.children.length === 0 ? empty : null}
        </div>
      ) : null}
    </>
  );
}
