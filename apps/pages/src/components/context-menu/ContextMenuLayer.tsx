import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "react-router";
import { typing } from "../../lib/keymap-targets.js";
import { ContextMenuList } from "./ContextMenuList.js";
import {
  type MenuPlacement,
  clampToViewport,
  closeContextMenu,
  contextMenuSnapshot,
  noteKeyboardContextMenu,
  openContextMenu,
  openedByKeyboard,
  subscribeContextMenu,
} from "./menu-model.js";
import { pageMenu } from "./page-menu.js";

/**
 * The page owns its right-click. Every `contextmenu` — a right button, a long
 * press, `Shift+F10`, the Menu key — opens this app's menu for whatever it
 * landed on; a surface with a menu of its own (the rail, the vault listing)
 * opens it and marks the event handled, and anything else gets the page's
 * menu: its link, its selected text, and the page itself.
 *
 * Two things keep the browser's own menu, deliberately. A text field, where
 * paste and spelling suggestions are the browser's to offer and a page cannot
 * reproduce them. And a right-click with Shift held, the conventional way
 * past a web app's menu to the browser's.
 */
export function ContextMenuLayer() {
  useContextMenuInterception(useNavigate());
  const open = useSyncExternalStore(
    subscribeContextMenu,
    contextMenuSnapshot,
    contextMenuSnapshot,
  );
  const list = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<MenuPlacement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPlaced(null);
      return;
    }
    const rect = list.current?.getBoundingClientRect();
    setPlaced(
      clampToViewport(open.x, open.y, rect?.width ?? 0, rect?.height ?? 0, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [open]);

  if (!open) return null;
  return (
    <ContextMenuList
      // A new menu is a new list: focus and the armed entry start over.
      key={`${open.x},${open.y},${open.label}`}
      listRef={(node) => {
        list.current = node;
      }}
      groups={open.groups}
      label={open.label}
      className="ctxmenu ctxmenu--floating"
      style={{
        left: placed?.left ?? open.x,
        top: placed?.top ?? open.y,
        // Measured before it is shown; opacity, not visibility, so the first
        // entry can take focus in the same frame.
        opacity: placed ? undefined : 0,
      }}
      onClose={(restore) => {
        const back = open.returnFocus;
        closeContextMenu();
        if (restore && back?.isConnected) back.focus({ preventScroll: true });
      }}
    />
  );
}

/** Where a keyboard-opened menu is about: the tree row the cursor is on. */
function keyboardTarget(): Element | null {
  const focused = document.activeElement;
  const row = focused?.getAttribute("aria-activedescendant");
  return (row ? document.getElementById(row) : null) ?? focused;
}

function useContextMenuInterception(navigate: (to: string) => void) {
  const go = useRef(navigate);
  go.current = navigate;
  useEffect(() => {
    let syntheticUntil = 0;
    const onKey = (event: KeyboardEvent) => {
      const menuKey =
        event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
      if (!menuKey || event.defaultPrevented) return;
      noteKeyboardContextMenu();
      if (typing(event.target)) return;
      const target = keyboardTarget();
      if (!target) return;
      event.preventDefault();
      syntheticUntil = Date.now() + 500;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left,
          clientY: rect.bottom,
        }),
      );
    };
    const first = (event: MouseEvent) => {
      // The browser may still send its own event for the key we already
      // answered; one menu per press.
      if (event.isTrusted && Date.now() < syntheticUntil) {
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
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", first, true);
      document.removeEventListener("contextmenu", last);
      closeContextMenu();
    };
  }, []);
}
