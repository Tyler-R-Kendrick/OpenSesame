import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { ContextMenuList } from "./ContextMenuList.js";
import { useContextMenuInput } from "./context-menu-input.js";
import {
  type MenuPlacement,
  clampToViewport,
  closeContextMenu,
  contextMenuSnapshot,
  subscribeContextMenu,
} from "./menu-model.js";

/**
 * The page owns its right-click. Every ask for a menu — a right button, a
 * long press, `Shift+F10`, the Menu key, `Shift+Enter` on a listing
 * (`context-menu-input.ts`) — opens this app's menu for whatever it landed
 * on; a surface with a menu of its own (the rail, the vault listing) opens it
 * and marks the event handled, and anything else gets the page's menu: its
 * link, its selected text, and the page itself. With a mouse it is a popover
 * at the pointer; on a phone, an action sheet at the bottom edge.
 *
 * Two things keep the browser's own menu, deliberately. A text field, where
 * paste and spelling suggestions are the browser's to offer and a page cannot
 * reproduce them. And a right-click with Shift held, the conventional way
 * past a web app's menu to the browser's.
 */
export function ContextMenuLayer() {
  useContextMenuInput(useNavigate());
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
  const close = (restore: boolean) => {
    const back = open.returnFocus;
    closeContextMenu();
    if (restore && back?.isConnected) back.focus({ preventScroll: true });
  };
  // A new menu is a new list: focus and the armed entry start over.
  const key = `${open.x},${open.y},${open.label}`;
  if (asSheet()) {
    // Under a finger the menu is an action sheet: a scrim makes covering
    // the page deliberate (and catches the tap meant to dismiss it), and
    // the list sits at the bottom edge, in reach of the thumb, named for
    // what it is about because it is no longer drawn beside it.
    return (
      <div className="sheet-layer ctxmenu-layer">
        <button
          type="button"
          className="scrim ctxmenu-scrim"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => close(true)}
        />
        <ContextMenuList
          key={key}
          groups={open.groups}
          label={open.label}
          title={open.label}
          className="ctxmenu ctxmenu--sheet"
          ignoreOutside=".ctxmenu-scrim"
          onClose={close}
        />
      </div>
    );
  }
  return (
    <ContextMenuList
      key={key}
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
      onClose={close}
    />
  );
}

/** The phone arrangement (DESIGN.md § Touch): coarse pointer or narrow. */
function asSheet(): boolean {
  return (
    window.matchMedia?.("(pointer: coarse), (max-width: 900px)").matches ??
    false
  );
}
