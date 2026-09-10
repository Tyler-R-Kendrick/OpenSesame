import { type RefObject, useEffect } from "react";
import type { NavigateFunction } from "react-router";
import { focusVaultListing, registerRailKeymap } from "../lib/keymap.js";
import { pageSteps, viewportIndex } from "../lib/tree-motion.js";

export function useRailKeyboard(
  treeRef: RefObject<HTMLElement | null>,
  navigateRef: RefObject<NavigateFunction>,
  currentToRef: RefObject<string>,
) {
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const rows = () => [
      ...tree.querySelectorAll<HTMLElement>("[data-rail-move]"),
    ];
    const selectedIndex = (list: HTMLElement[]) => {
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
    const activate = (row: HTMLElement | undefined) => {
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
      if (!selected?.classList.contains("railtree__row--child")) return;
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
