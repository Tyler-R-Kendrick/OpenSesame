import { type RefObject, useEffect } from "react";
import { useLocation } from "react-router";
import { firstControl, keyboardIsIdle, landFocus } from "../../lib/focus.js";

type Panes = {
  tree: RefObject<HTMLElement | null>;
  list: RefObject<HTMLElement | null>;
  detail: RefObject<HTMLElement | null>;
  newItem: RefObject<HTMLElement | null>;
};

const hidden = (pane: HTMLElement) => getComputedStyle(pane).display === "none";

/**
 * Every navigation into or within the vault — an unlock, `g v`, Back from an
 * item, from settings, from an editor — lands the keyboard where the cursor
 * is: the tree, or the "New item" link of an empty vault. It yields to a
 * caret something else already placed (an editor's first field), and on a
 * phone, where only one pane is on screen, it follows the visible pane: a
 * hidden tree cannot hold focus, and a Back that hides the detail must hand
 * the keyboard back to the list rather than leave it on `<body>`. The phone's
 * first pane is the section tree, and with it on screen the keyboard belongs
 * there, not on a buffer nobody can see.
 */
function focusTree(pane: HTMLElement, tree: HTMLElement, idle: boolean) {
  const active = document.activeElement;
  if (idle || (active !== null && !pane.contains(active))) landFocus(tree);
}

/** The keyboard is on a pane this arrival just hid, where nothing can hold it. */
function stranded(active: Element | null, ...panes: (HTMLElement | null)[]) {
  return panes.some(
    (pane) => pane && active !== null && hidden(pane) && pane.contains(active),
  );
}

function focusList(panes: Panes, list: HTMLElement, detail: HTMLElement) {
  const active = document.activeElement;
  const left = stranded(active, detail, panes.tree.current);
  if (!keyboardIsIdle() && !left) return;
  if (landFocus(list.querySelector('[role="tree"]:not([hidden])'))) return;
  if (!landFocus(panes.newItem.current)) landFocus(firstControl(list));
}

export function useVaultFocus(panes: Panes) {
  const { key } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key is the navigation itself — the effect re-runs per arrival, and reads the panes at that moment
  useEffect(() => {
    const list = panes.list.current;
    const detail = panes.detail.current;
    if (!list || !detail) return;
    const treePane = panes.tree.current;
    const tree = treePane?.querySelector<HTMLElement>('[role="tree"]');
    if (tree && treePane && !hidden(treePane)) {
      return focusTree(treePane, tree, keyboardIsIdle());
    }
    if (!hidden(list)) return focusList(panes, list, detail);
    const active = document.activeElement;
    if (keyboardIsIdle() || (active !== null && list.contains(active))) {
      landFocus(detail);
    }
  }, [key]);
}
