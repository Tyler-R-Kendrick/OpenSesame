import { type RefObject, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { searchInCommandBar } from "../lib/command-bar/focus.js";
import { landFocus } from "../lib/focus.js";
import { type VaultKeymapTarget, registerVaultKeymap } from "../lib/keymap.js";
import type { WorkspaceRow } from "./RecordWorkspace.js";

type State = {
  rows: WorkspaceRow[];
  selectedId: string | null;
  setCursor: (id: string) => void;
  preview: boolean;
  closeSearch: () => void;
  parent: () => void;
};
type Pane = RefObject<HTMLDivElement | null>;
function recordTarget(
  state: RefObject<State>,
  navigate: ReturnType<typeof useNavigate>,
  tree: Pane,
  list: Pane,
  detail: Pane,
): VaultKeymapTarget {
  const visible = () => (list.current?.getClientRects().length ?? 0) > 0;
  const current = () =>
    state.current.rows.find((row) => row.id === state.current.selectedId) ??
    state.current.rows[0];
  const open = (row: WorkspaceRow | undefined, replace = false) => {
    if (!row || !visible()) return;
    if (row.to) navigate(row.to, { replace });
    else row.onOpen?.();
  };
  const move = (index: number) => {
    if (!visible()) return;
    const rows = state.current.rows;
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row) {
      state.current.setCursor(row.id);
      if (state.current.preview) open(row, true);
      tree.current
        ?.querySelector<HTMLElement>(`[data-record-id="${CSS.escape(row.id)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
    tree.current?.focus();
  };
  const index = () =>
    state.current.rows.findIndex((row) => row.id === state.current.selectedId);
  const command = (label: RegExp, pane: HTMLElement | null) => {
    if ((pane?.getClientRects().length ?? 0) === 0) return;
    const control = [
      ...(pane?.querySelectorAll<HTMLElement>("button, a") ?? []),
    ].find(
      (element) =>
        label.test(element.getAttribute("aria-label") ?? "") &&
        !element.matches(":disabled"),
    );
    control?.click();
  };
  return {
    hasRows: () => visible() && state.current.rows.length > 0,
    focus: () => {
      if (visible()) landFocus(tree.current);
    },
    next: (count = 1) => move(index() + count),
    previous: (count = 1) => move(index() < 0 ? 0 : index() - count),
    first: () => move(0),
    last: () => move(state.current.rows.length - 1),
    toIndex: move,
    page: (direction, size) =>
      move(
        index() +
          direction *
            Math.max(
              1,
              Math.floor(
                (tree.current?.clientHeight ?? 280) /
                  28 /
                  (size === "half" ? 2 : 1),
              ),
            ),
      ),
    enter: () => open(current()),
    activate: () => open(current()),
    parent: () => {
      state.current.parent();
    },
    search: searchInCommandBar,
    closeSearch: () => state.current.closeSearch(),
    create: () => command(/^(New|Add|Register|Create)\b/i, list.current),
    edit: () => command(/^Edit\b/i, detail.current),
    trash: () =>
      command(
        /^(?:Confirm\s+)?(?:Delete|Remove|Revoke|Release|Move to trash)\b/i,
        detail.current,
      ),
    copySecret: () => command(/^Copy\b/i, detail.current),
    copyUsername: () => command(/^Copy.*(id|name)/i, detail.current),
    favorite: () =>
      command(/^(Add to|Remove from) favorites$/i, detail.current),
    share: () => command(/^Share\b/i, detail.current),
  };
}

/** Use the same listing commands and count prefixes as the vault tree. */
export function useRecordMotion({
  rows,
  selectedId,
  setCursor,
  tree,
  list,
  detail,
  preview,
  closeSearch,
  parent,
}: {
  rows: WorkspaceRow[];
  selectedId: string | null;
  setCursor: (id: string) => void;
  tree: RefObject<HTMLDivElement | null>;
  list: RefObject<HTMLDivElement | null>;
  detail: RefObject<HTMLDivElement | null>;
  preview: boolean;
  closeSearch: () => void;
  parent: () => void;
}) {
  const navigate = useNavigate();
  const state = useRef({
    rows,
    selectedId,
    setCursor,
    preview,
    closeSearch,
    parent,
  });
  state.current = { rows, selectedId, setCursor, preview, closeSearch, parent };

  useEffect(
    () =>
      registerVaultKeymap(recordTarget(state, navigate, tree, list, detail)),
    [navigate, tree, list, detail],
  );
}
