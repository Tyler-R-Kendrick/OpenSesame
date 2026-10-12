import { type RefObject, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { clearCommandBarSearch } from "../lib/command-bar/focus.js";
import { keyboardIsIdle, landFocus } from "../lib/focus.js";
import { swipeBack } from "../lib/gestures.js";
import { focusRailListing } from "../lib/keymap.js";
import { usePaneTrail } from "../lib/pane-trail.js";
import { useNarrow } from "../lib/use-narrow.js";
import { useVaultSearch } from "../sections/vault/use-vault-search.js";
import type { RecordWorkspaceProps } from "./RecordWorkspace.js";
import { useRecordMotion } from "./record-workspace-motion.js";
function useRecordFocus({
  treePane,
  list,
  tree,
  detail,
  narrow,
  pane,
  key,
}: {
  treePane: RefObject<HTMLDivElement | null>;
  list: RefObject<HTMLDivElement | null>;
  tree: RefObject<HTMLDivElement | null>;
  detail: RefObject<HTMLDivElement | null>;
  narrow: boolean;
  pane: string;
  key: string;
}) {
  // Route arrivals yield to a form or dialog's caret; hiding its pane returns
  // the keyboard to the visible listing, as it does in the vault.
  // Let the record's own focus-after-save effect settle before choosing an arrival target.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key identifies route arrivals; row-count changes do not take the caret
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (document.activeElement?.closest('[role="dialog"]')) return;
      const active = document.activeElement;
      const stranded = [treePane.current, list.current, detail.current].some(
        (element) =>
          element?.contains(active) &&
          getComputedStyle(element).display === "none",
      );
      if (!keyboardIsIdle() && !stranded) return;
      if (narrow && pane === "tree") {
        landFocus(treePane.current?.querySelector('[role="tree"]'));
      } else if (narrow && pane === "detail") {
        landFocus(detail.current);
      } else {
        // Async rows may still be empty on arrival. Their visible tree owns
        // the keyboard even then; phone pathbar links can be hidden.
        landFocus(tree.current);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, narrow, pane, treePane, list, tree, detail]);

  useEffect(() => {
    if (narrow && pane === "tree") clearCommandBarSearch();
  }, [narrow, pane]);
}

export function useRecordCreate(list: RefObject<HTMLDivElement | null>) {
  const createControl = useRef<HTMLElement | null>(null);
  const [createLabel, setCreateLabel] = useState<string | null>(null);
  const [createDisabled, setCreateDisabled] = useState(false);
  const [importLabel, setImportLabel] = useState<string | null>(null);
  const [exportLabel, setExportLabel] = useState<string | null>(null);
  useEffect(() => {
    const find = () => {
      const control = [
        ...(list.current?.querySelectorAll<HTMLElement>("button, a") ?? []),
      ].find((element) =>
        /^(New|Add|Register|Create|Grant)\b/i.test(
          element.getAttribute("aria-label") ?? "",
        ),
      );
      const labels = [
        ...(list.current?.querySelectorAll<HTMLElement>(
          ".record-workspace__commands [aria-label]",
        ) ?? []),
      ].map((element) => element.getAttribute("aria-label") ?? "");
      setImportLabel(labels.find((label) => /^Import\b/.test(label)) ?? null);
      setExportLabel(labels.find((label) => /^Export\b/.test(label)) ?? null);
      createControl.current = control ?? null;
      setCreateLabel(control?.getAttribute("aria-label") ?? null);
      setCreateDisabled(control?.matches(":disabled") ?? false);
    };
    find();
    const observer = new MutationObserver(find);
    if (list.current)
      observer.observe(list.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "aria-label"],
      });
    return () => observer.disconnect();
  }, [list]);
  return {
    createControl,
    createLabel,
    createDisabled,
    importLabel,
    exportLabel,
  };
}

function mayPreview(search: string) {
  const params = new URLSearchParams(search);
  return (
    !params.has("new") &&
    !params.has("edit") &&
    params.get("draft") !== "new" &&
    !["new", "edit"].includes(params.get("action") ?? "")
  );
}

function useRecordSwipe(
  narrow: boolean,
  pane: "tree" | "list" | "detail",
  detail: RefObject<HTMLDivElement | null>,
  list: RefObject<HTMLDivElement | null>,
  ascend: ReturnType<typeof usePaneTrail>,
  listPath: string,
  rootPath: string,
) {
  useEffect(() => {
    const target =
      pane === "detail"
        ? detail.current
        : pane === "list"
          ? list.current
          : null;
    if (!narrow || !target) return;
    return swipeBack(target, () =>
      ascend(
        pane === "detail" ? "list" : "tree",
        pane === "detail" ? listPath : rootPath,
      ),
    );
  }, [narrow, pane, ascend, listPath, rootPath, detail, list]);
}

export function useRecordWorkspace({
  rows,
  selectedId,
  rootPath,
  listPath,
  detailOpen,
  section,
  title,
}: RecordWorkspaceProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const treePane = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const { query, close } = useVaultSearch(list, tree);
  const needle = (query ?? "").trim().toLowerCase();
  const shown = rows.filter(
    (row) => !needle || row.label.toLowerCase().includes(needle),
  );
  const [cursor, setCursor] = useState<string | null>(selectedId);
  useEffect(() => setCursor(selectedId), [selectedId]);
  const selected = rows.find((row) => row.id === selectedId);
  const atRoot =
    location.pathname === rootPath && !location.search && !location.hash;
  const pane =
    detailOpen || selectedId !== null ? "detail" : atRoot ? "tree" : "list";
  const ascend = usePaneTrail(pane);
  const parent = () =>
    narrow
      ? ascend(
          pane === "detail" ? "list" : "tree",
          pane === "detail" ? listPath : rootPath,
        )
      : focusRailListing();
  useRecordMotion({
    rows: shown,
    selectedId: cursor,
    setCursor,
    tree,
    list,
    detail,
    preview: !narrow && mayPreview(location.search),
    closeSearch: close,
    parent,
  });

  useRecordSwipe(narrow, pane, detail, list, ascend, listPath, rootPath);

  useRecordFocus({
    treePane,
    list,
    tree,
    detail,
    narrow,
    pane,
    key: location.key,
  });
  const crumbs = [
    { label: section, to: rootPath },
    { label: title, to: selected ? listPath : undefined },
    ...(selected ? [{ label: selected.label }] : []),
  ];
  const creation = useRecordCreate(list);
  return {
    location,
    navigate,
    narrow,
    treePane,
    list,
    tree,
    detail,
    needle,
    shown,
    cursor,
    selected,
    pane,
    ascend,
    crumbs,
    ...creation,
  };
}
