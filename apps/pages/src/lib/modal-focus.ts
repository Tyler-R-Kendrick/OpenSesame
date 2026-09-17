import type { RefObject } from "react";
import { useEffect } from "react";
import { handlePaneEscape } from "./pane-escape.js";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Keep keyboard focus inside a modal sheet and restore its trigger on close. */
export function useModalFocus(
  open: boolean,
  container: RefObject<HTMLElement | null>,
  initial: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    initial.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        // Support sits above ceremony sheets. Both listen on window; without
        // this, Escape would close every open sheet at once. The nav drawer is
        // a modal surface of the same kind — it is in this list or Escape
        // finds no topmost surface at all and closes nothing.
        const sheets = document.querySelectorAll(".sheet, .drawer");
        const top = sheets.item(sheets.length - 1);
        if (container.current !== top) return;
        handlePaneEscape(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key === "Tab") trapTab(event, container.current);
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (trigger instanceof HTMLElement) trigger.focus();
    };
  }, [close, container, initial, open]);
}

function trapTab(event: KeyboardEvent, pane: HTMLElement | null): void {
  const chrome = document.querySelector<HTMLElement>(".statusline");
  const roots = [pane, chrome].filter((node): node is HTMLElement =>
    Boolean(node),
  );
  const focusable = roots
    .flatMap((root) =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)),
    )
    .filter((element) => element.tabIndex >= 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  const inside = roots.some((root) => root === active || root.contains(active));
  if (active === pane) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (!inside) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
