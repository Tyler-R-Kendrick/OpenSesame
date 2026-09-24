/**
 * The page's context menu: one menu open at a time, opened by whatever was
 * right-clicked (or by `Shift+F10` / the Menu key on whatever holds focus).
 *
 * A menu is groups of entries, each entry a verb the page already has — the
 * menu adds no authority and no second road to anything. Where a verb has a
 * key, the entry shows it, so the menu teaches the keymap it stands in for.
 */

export type MenuItem = {
  id: string;
  label: string;
  /** The key that does the same thing, shown beside the label. */
  hint?: string;
  /** A checkbox entry (`menuitemcheckbox`), with its current state. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /**
   * A destructive entry asks twice: the first activation re-labels it with
   * this question and keeps the menu open, the second runs it — the same
   * arm-then-fire the detail pane's delete key uses.
   */
  confirm?: string;
  run: () => void;
};

export type MenuGroup = readonly MenuItem[];

/** A viewport point a menu opens at. */
export type MenuPoint = { x: number; y: number };

/** Where a measured menu is drawn, kept inside the viewport. */
export type MenuPlacement = { left: number; top: number };

export type OpenMenu = {
  groups: readonly MenuGroup[];
  /** The accessible name of the menu, e.g. "trash/ actions". */
  label: string;
  x: number;
  y: number;
  /** Where focus goes back to when the menu closes without navigating. */
  returnFocus: HTMLElement | null;
};

let open: OpenMenu | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function contextMenuSnapshot(): OpenMenu | null {
  return open;
}

export function subscribeContextMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keyboard-opened menus sit under their row, not at a pointer. */
let keyboardUntil = 0;

export function noteKeyboardContextMenu(now = Date.now()): void {
  keyboardUntil = now + 400;
}

export function openedByKeyboard(now = Date.now()): boolean {
  return now <= keyboardUntil;
}

/**
 * Open a menu for a `contextmenu` event. `anchor` is the thing the menu is
 * about; a keyboard-opened menu is placed under it, a pointer-opened one at
 * the pointer.
 */
export function openContextMenu(
  event: { clientX: number; clientY: number; preventDefault: () => void },
  anchor: Element | null,
  label: string,
  groups: readonly MenuGroup[],
): void {
  event.preventDefault();
  const visible = groups.filter((group) => group.length > 0);
  if (visible.length === 0) return;
  const point = openedByKeyboard()
    ? anchorPoint(anchor)
    : { x: event.clientX, y: event.clientY };
  const active = document.activeElement;
  open = {
    groups: visible,
    label,
    ...point,
    returnFocus: active instanceof HTMLElement ? active : null,
  };
  emit();
}

export function closeContextMenu(): void {
  if (!open) return;
  open = null;
  emit();
}

function anchorPoint(anchor: Element | null): MenuPoint {
  const rect = anchor?.getBoundingClientRect();
  const point: MenuPoint = rect
    ? { x: rect.left + Math.min(24, rect.width / 2), y: rect.bottom }
    : { x: 16, y: 16 };
  return point;
}

/** Keep a `width`×`height` menu opened at `x`,`y` inside the viewport. */
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: { width: number; height: number },
  margin = 8,
): MenuPlacement {
  const flipX = x + width + margin > viewport.width ? x - width : x;
  const flipY = y + height + margin > viewport.height ? y - height : y;
  const placement: MenuPlacement = {
    left: Math.max(margin, Math.min(flipX, viewport.width - width - margin)),
    top: Math.max(margin, Math.min(flipY, viewport.height - height - margin)),
  };
  return placement;
}

/** The next enabled entry after `from`, wrapping, or -1. */
export function stepIndex(
  items: readonly MenuItem[],
  from: number,
  delta: 1 | -1,
): number {
  const count = items.length;
  for (let step = 1; step <= count; step++) {
    const at = (((from + delta * step) % count) + count) % count;
    if (!items[at]?.disabled) return at;
  }
  return -1;
}

/** Type-ahead: the next enabled entry after `from` whose label starts with `key`. */
export function typeaheadIndex(
  items: readonly MenuItem[],
  from: number,
  key: string,
): number {
  const needle = key.toLowerCase();
  const count = items.length;
  for (let step = 1; step <= count; step++) {
    const at = (from + step) % count;
    const item = items[at];
    if (item && !item.disabled && item.label.toLowerCase().startsWith(needle))
      return at;
  }
  return -1;
}
