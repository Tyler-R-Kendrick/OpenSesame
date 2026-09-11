import { type RefObject, useEffect } from "react";
import type { NavigateFunction } from "react-router";
import { hrefContainsCurrent } from "../lib/page-to-tree.js";
import { focusVaultListing, registerRailKeymap } from "../lib/keymap.js";
import { pageSteps, viewportIndex } from "../lib/tree-motion.js";
import { setRailCursor } from "./rail-cursor.js";

function locationHere(): string {
  return (
    window.location.pathname + window.location.search + window.location.hash
  );
}

/**
 * Whether moving the rail cursor should also drive the page.
 *
 * A collapsed directory is cursor-only: its hash would otherwise index the
 * catalog (Encryption, Developer tools, …) while the subtree is closed.
 * Leaves of an expanded group still preview so the page stays in sync.
 */
export function railMoveNavigates(
  row: HTMLElement,
  from: HTMLElement | undefined,
  dest: string,
  here: string,
): boolean {
  const parentMove =
    from !== undefined &&
    Number(row.getAttribute("aria-level") ?? 1) <
      Number(from.getAttribute("aria-level") ?? 1);
  if (parentMove && hrefContainsCurrent(dest, here)) return false;
  if (row.getAttribute("aria-expanded") === "false") {
    const path = here.replace(/[?#].*$/, "");
    if (dest.startsWith(`${path}#`)) return false;
  }
  return true;
}

export function useRailKeyboard(
  treeRef: RefObject<HTMLElement | null>,
  navigateRef: RefObject<NavigateFunction>,
  currentToRef: RefObject<string>,
) {
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const rows = () => [
      ...tree.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ];
    const selectedIndex = (list: HTMLElement[]) => {
      const activeId = tree.getAttribute("aria-activedescendant");
      const byId = list.findIndex((row) => row.id === activeId);
      if (byId >= 0) return byId;
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
    const activate = (row: HTMLElement | undefined, from?: HTMLElement) => {
      if (!row) return;
      const to = row.dataset.railTo;
      if (to) {
        const here = currentToRef.current || locationHere();
        currentToRef.current = to;
        if (railMoveNavigates(row, from, to, here)) {
          navigateRef.current(to);
        }
      }
      setRailCursor(row.id);
      tree.setAttribute("aria-activedescendant", row.id);
      tree.focus({ preventScroll: true });
      row.scrollIntoView?.({ block: "nearest" });
    };
    const move = (delta: number) => {
      const list = rows();
      if (list.length === 0) return;
      const at = selectedIndex(list);
      const from = at >= 0 ? list[at] : undefined;
      const next =
        at < 0 ? 0 : Math.min(Math.max(at + delta, 0), list.length - 1);
      if (next === at) return;
      activate(list[next], from);
    };
    const dive = (row: HTMLElement) => {
      if (row.hasAttribute("data-rail-preview")) return;
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
      goTo: (path) => {
        const list = rows();
        const row =
          list.find((item) => item.dataset.railTo === path) ??
          list.find((item) => (item.dataset.railTo ?? "").startsWith(path));
        if (row) activate(row);
        else navigateRef.current(path);
      },
      ...branchActions(tree, () => rows()[selectedIndex(rows())], dive),
      activate: () => rows()[selectedIndex(rows())]?.click(),
    });
  }, [treeRef, navigateRef, currentToRef]);
}

function branchActions(
  tree: HTMLElement,
  current: () => HTMLElement | undefined,
  dive: (row: HTMLElement) => void,
) {
  return {
    enter: () => {
      const row = current();
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
        const first = kids.querySelector<HTMLAnchorElement>("a.railtree__row");
        dive(first ?? row);
        return;
      }
      dive(row);
    },
    parent: () => {
      const selected = current();
      if (!selected) return;
      if (selected.getAttribute("aria-expanded") === "true") {
        selected.click();
        tree.focus({ preventScroll: true });
        return;
      }
      if (!selected.classList.contains("railtree__row--child")) return;
      const all = [
        ...tree.querySelectorAll<HTMLElement>(
          "[data-rail-move], a.railtree__row",
        ),
      ];
      const from = all.indexOf(selected);
      for (let at = from - 1; at >= 0; at--) {
        const candidate = all[at];
        if (
          candidate &&
          Number(candidate.getAttribute("aria-level")) <
            Number(selected.getAttribute("aria-level"))
        ) {
          candidate.click();
          tree.focus({ preventScroll: true });
          return;
        }
      }
    },
  };
}
