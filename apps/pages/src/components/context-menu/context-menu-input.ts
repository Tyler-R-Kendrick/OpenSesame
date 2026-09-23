import { useEffect, useRef } from "react";
import { longPress } from "../../lib/gestures.js";
import { typing } from "../../lib/keymap-targets.js";
import {
  closeContextMenu,
  noteKeyboardContextMenu,
  openContextMenu,
  openedByKeyboard,
} from "./menu-model.js";
import { pageMenu } from "./page-menu.js";

/**
 * Every road to the context menu ends in one `contextmenu` event on the
 * thing it is about, so a surface with its own menu (the rail, the vault
 * listing) answers all of them with one handler:
 *
 * - **a right button** — the browser's own event;
 * - **`Shift+F10` or the Menu key** — the platform keys for "the menu of the
 *   focused thing". On a tree the event lands on the cursor row;
 * - **`Shift+Enter` on a listing** — the same, for keyboards with neither
 *   (a Mac has no Menu key, and F10 there sits behind `fn`). Only on a tree:
 *   on a link or a button Shift+Enter keeps its native meaning;
 * - **a long press** — a finger or a stylus held still. Android sends its own
 *   `contextmenu` for it; iOS Safari sends none, so the press is recognised
 *   here, and whichever event comes first is the only one that counts. The
 *   lift that ends a hold is not a tap: its click is swallowed, so holding a
 *   link asks for its menu instead of following it.
 */
export function useContextMenuInput(navigate: (to: string) => void): void {
  const go = useRef(navigate);
  go.current = navigate;
  useEffect(() => {
    /** Until when a trusted `contextmenu` duplicates one already answered. */
    let answeredUntil = 0;
    const open = (target: Element, x: number, y: number) => {
      answeredUntil = Date.now() + 700;
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }),
      );
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isMenuKey(event)) return;
      noteKeyboardContextMenu();
      if (typing(event.target)) return;
      const target = keyboardTarget();
      if (!target) return;
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      open(target, rect.left, rect.bottom);
    };

    const press = longPressRecognizer(open);

    const first = (event: MouseEvent) => {
      if (event.isTrusted) press.nativeMenu();
      // The browser may still send its own event for a key or a hold we
      // already answered; one menu per ask.
      if (event.isTrusted && Date.now() < answeredUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.isTrusted && event.shiftKey && !openedByKeyboard()) {
        event.stopImmediatePropagation();
      }
    };
    const last = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (typing(target)) return;
      if (target?.closest(".ctxmenu")) {
        event.preventDefault();
        return;
      }
      const groups = pageMenu(
        target,
        window.getSelection()?.toString() ?? "",
        (to) => go.current(to),
      );
      openContextMenu(event, target, "Page actions", groups);
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("contextmenu", first, true);
    document.addEventListener("contextmenu", last);
    const stopPress = press.attach(document);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", first, true);
      document.removeEventListener("contextmenu", last);
      stopPress();
      closeContextMenu();
    };
  }, []);
}

function isMenuKey(event: KeyboardEvent): boolean {
  if (event.key === "ContextMenu") return true;
  if (event.shiftKey && event.key === "F10") return true;
  return (
    event.shiftKey &&
    event.key === "Enter" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.target instanceof Element &&
    event.target.getAttribute("role") === "tree"
  );
}

/** Where a keyboard-opened menu is about: the tree row the cursor is on. */
function keyboardTarget(): Element | null {
  const focused = document.activeElement;
  const row = focused?.getAttribute("aria-activedescendant");
  return (row ? document.getElementById(row) : null) ?? focused;
}

/**
 * A finger held still, on anything that is not a text field (whose own
 * press-and-hold is the platform's caret and callout). The hold itself is
 * `longPress`'s; this adds what a page-wide menu needs on top of it.
 */
function longPressRecognizer(
  open: (target: Element, x: number, y: number) => void,
) {
  /** When the browser last answered a hold with its own event (Android). */
  let nativeAt = Number.NEGATIVE_INFINITY;
  /** A hold opened a menu; the lift's click must not also activate. */
  let held = false;

  const hold = (event: PointerEvent) => {
    const at = event.target instanceof Element ? event.target : null;
    if (!at?.isConnected || typing(at) || at.closest(".ctxmenu")) return;
    held = true;
    if (performance.now() - nativeAt < 700) return;
    navigator.vibrate?.(8);
    open(at, event.clientX, event.clientY);
  };
  const down = () => {
    held = false;
  };
  const click = (event: MouseEvent) => {
    if (!held) return;
    held = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  return {
    /** The browser answered a hold itself: ours stands down for this one. */
    nativeMenu() {
      nativeAt = performance.now();
    },
    attach(root: Document): () => void {
      const stop = longPress(root.documentElement, hold);
      root.addEventListener("pointerdown", down, true);
      root.addEventListener("click", click, true);
      return () => {
        stop();
        root.removeEventListener("pointerdown", down, true);
        root.removeEventListener("click", click, true);
      };
    },
  };
}
