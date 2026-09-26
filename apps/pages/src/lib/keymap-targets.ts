/**
 * The listings the keymap drives, and which one a key means right now.
 *
 * Split out of `keymap.ts` so that file stays inside the module-size budget
 * (ADR 0093). A listing registers itself here while it is mounted; the
 * handler asks which one the event belongs to. `keymap.ts` re-exports every
 * name below, so nothing about the public surface moved.
 */

export type ListingMotion = {
  next: (count?: number) => void;
  previous: (count?: number) => void;
  first: () => void;
  last: () => void;
  enter: () => void;
  parent: () => void;
  activate: () => void;
  page?: (direction: 1 | -1, size: "half" | "full") => void;
  edge?: (where: "high" | "mid" | "low") => void;
  focus?: () => void;
  /** 0-based. `5G` lands here instead of first()+next(4), which reshapes the rail. */
  toIndex?: (index: number) => void;
  /** `gv` / `gs` — move the rail index to that section, not only the page. */
  goTo?: (path: string) => void;
};

export type VaultKeymapTarget = ListingMotion & {
  hasRows?: () => boolean;
  search: () => void;
  closeSearch: () => void;
  copySecret: () => void;
  copyUsername: () => void;
  edit: () => void;
  trash: () => void;
  create: () => void;
  favorite: () => void;
  share: () => void;
};

export type RailKeymapTarget = ListingMotion;

export type SearchKeymapTarget = {
  search: () => void;
  closeSearch: () => void;
};

let vaultTarget: VaultKeymapTarget | null = null;

export function registerVaultKeymap(target: VaultKeymapTarget): () => void {
  vaultTarget = target;
  return () => {
    if (vaultTarget === target) vaultTarget = null;
  };
}

let railTarget: RailKeymapTarget | null = null;

export function registerRailKeymap(target: RailKeymapTarget): () => void {
  railTarget = target;
  return () => {
    if (railTarget === target) railTarget = null;
  };
}

let searchTarget: SearchKeymapTarget | null = null;

export function registerSearchKeymap(target: SearchKeymapTarget): () => void {
  searchTarget = target;
  return () => {
    if (searchTarget === target) searchTarget = null;
  };
}

/** The vault listing mounted right now, if any. */
export function currentVaultTarget(): VaultKeymapTarget | null {
  return vaultTarget;
}

/** The rail listing mounted right now, if any. */
export function currentRailTarget(): RailKeymapTarget | null {
  return railTarget;
}

/** The search box mounted right now, if any. */
export function currentSearchTarget(): SearchKeymapTarget | null {
  return searchTarget;
}

export function listingOf(event: KeyboardEvent): "rail" | "vault" | null {
  const node = event.target;
  if (node instanceof Element) {
    if (node.closest(".railtree")) return "rail";
    if (node.closest(".vtree__rows")) return "vault";
  }
  return null;
}

export function movementTarget(event: KeyboardEvent): ListingMotion | null {
  const listing = listingOf(event);
  if (listing === "rail") return railTarget;
  if (listing === "vault") return vaultTarget;
  return vaultTarget?.hasRows?.() === false
    ? railTarget
    : (vaultTarget ?? railTarget);
}

export function focusRailListing(): void {
  railTarget?.focus?.();
}

export function focusVaultListing(): void {
  vaultTarget?.focus?.();
}

/**
 * A context menu is open. It owns every key until it closes — the page's
 * keymap and its Escape ladder both stand down, whichever listener the
 * browser happens to run first.
 */
export function contextMenuOpen(): boolean {
  return document.querySelector('.ctxmenu[role="menu"]') !== null;
}

/**
 * A status mark's sentence is showing (`components/status-twin.ts`). The
 * next Escape is that bubble's: the Escape ladder and the keymap's Escape
 * stand down for it, so one press dismisses one thing.
 */
export function statusBubbleOpen(): boolean {
  return document.querySelector(".status-bubble") !== null;
}

export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("[data-config-source]")) return true;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}
