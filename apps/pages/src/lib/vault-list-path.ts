import { useNarrow } from "./use-narrow.js";

/** Where a phone's "all items" list lives: its bare `/vault` is the tree. */
export const PHONE_ALL_ITEMS = "/vault?f=all";

/**
 * Where "back to the list" goes from an item.
 *
 * The active filter and folder travel in the query string, so going back keeps
 * them. A phone's bare `/vault` is the section tree, not a list, so an item
 * reached without a filter (a deep link, a save) goes back to the list of
 * everything rather than a screen further up than the button promises.
 */
export function vaultListPath(search: string, narrow: boolean): string {
  if (!narrow) return `/vault${search}`;
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of ["f", "folder"]) {
    const value = params.get(key);
    if (value !== null) kept.set(key, value);
  }
  if (kept.size === 0) kept.set("f", "all");
  return `/vault?${kept.toString()}`;
}

/** The way back from an item: where it goes, and what the key says. */
export function useVaultList(search: string): {
  listPath: string;
  backLabel: string;
} {
  const listPath = vaultListPath(search, useNarrow());
  return { listPath, backLabel: vaultBackLabel(listPath) };
}

/**
 * The tree's current entry. The bare vault is "all items" on a desktop; on a
 * phone that entry has its own address, and the cursor has to stand on it.
 */
export function treeCurrent(selected: string, allTo: string): string {
  return selected === "/vault" ? allTo : selected;
}

/** The tree's "all items" entry: the vault itself, or a phone's list of it. */
export function useVaultAllTo(): string {
  return useNarrow() ? PHONE_ALL_ITEMS : "/vault";
}

function vaultBackLabel(listPath: string): string {
  return listPath === "/vault" || listPath === PHONE_ALL_ITEMS
    ? "Back to all items"
    : "Back to list";
}

/**
 * The pane a phone shows: the section tree on the bare `/vault`, a list when a
 * filter or folder is named, the buffer under `/vault/…`. A desktop draws every
 * pane and never reads this.
 */
export function vaultPane(
  pathname: string,
  params: URLSearchParams,
): "tree" | "list" | "detail" {
  if (pathname !== "/vault") return "detail";
  return params.has("f") || params.has("folder") ? "list" : "tree";
}
