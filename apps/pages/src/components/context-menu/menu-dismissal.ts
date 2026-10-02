import { type RefObject, useEffect, useRef } from "react";
import { type MenuItem, stepIndex, typeaheadIndex } from "./menu-model.js";

export type MenuLive = {
  items: readonly MenuItem[];
  active: number;
  setActive: (index: number) => void;
  activate: (item: MenuItem | undefined) => void;
  onClose: (restore: boolean) => void;
  /** Open the current row's submenu, when it has one. */
  onRight: () => void;
  /** Close an open submenu. True when one was open. */
  onLeft: () => boolean;
};

/**
 * Arrows, Home, End, Enter, Space and a letter. Anything else is ignored.
 * The caller already stopped Tab, a held Enter, and the submenu keys.
 */
function moveMenu(event: KeyboardEvent, live: MenuLive): void {
  const { items: list, active: at, setActive, activate } = live;
  const move = (to: number) => {
    if (to >= 0) setActive(to);
  };
  if (event.key === "ArrowDown") move(stepIndex(list, at, 1));
  else if (event.key === "ArrowUp") move(stepIndex(list, at, -1));
  else if (event.key === "Home") move(stepIndex(list, -1, 1));
  else if (event.key === "End") move(stepIndex(list, list.length, -1));
  else if (event.key === "Enter" || event.key === " ") activate(list[at]);
  else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
    move(typeaheadIndex(list, at, event.key));
  }
}

/**
 * While the menu is open it owns the keyboard — every key but Tab stops here,
 * so a `j` meant for the menu never moves the tree beneath it — and any
 * pointer-down outside it, a scroll, a blur or a new width closes it (a
 * scrolled page would leave it pointing at a row that moved away).
 */
export function useMenuDismissal(
  own: RefObject<HTMLDivElement | null>,
  live: RefObject<MenuLive>,
  ignoreOutside: string | undefined,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { onClose } = live.current;
      if (event.key === "Tab") {
        onClose(true);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      // The key that opened the menu, held: it may not also choose for you.
      if (event.repeat && (event.key === "Enter" || event.key === " ")) return;
      if (event.key === "Escape") {
        if (!live.current.onLeft()) onClose(true);
        return;
      }
      if (event.key === "ArrowRight") {
        live.current.onRight();
        return;
      }
      if (event.key === "ArrowLeft") {
        live.current.onLeft();
        return;
      }
      moveMenu(event, live.current);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && own.current?.contains(target)) return;
      if (target && ignoreOutside && target.closest(ignoreOutside)) return;
      live.current.onClose(false);
    };
    const away = () => live.current.onClose(false);
    // A phone's keyboard or URL bar changing the height is not the person
    // leaving; a new width (rotation, a resized window) re-lays the page.
    const width = window.innerWidth;
    const resized = () => {
      if (window.innerWidth !== width) away();
    };
    // Opening can nudge its own row into view (the cursor follows the row
    // that was asked about); only a scroll after that is the person's.
    const openedAt = performance.now();
    const scrolled = (event: Event) => {
      // A long sheet scrolls itself; that is reading the menu, not leaving.
      if (event.target instanceof Node && own.current?.contains(event.target))
        return;
      if (performance.now() - openedAt > 250) away();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", away);
    window.addEventListener("resize", resized);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", resized);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [own, live, ignoreOutside]);
}

/** The ref the dismissal listeners read. Reassigned every render. */
export function useMenuLive(initial: MenuLive): RefObject<MenuLive> {
  const live = useRef<MenuLive>(initial);
  live.current = initial;
  return live;
}
