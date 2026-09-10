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
        // this, Escape would close every open sheet at once.
        const sheets = document.querySelectorAll(".sheet");
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
  const focusable = Array.from(
    pane?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
  ).filter((element) => element.tabIndex >= 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (active === pane) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (!pane?.contains(active)) {
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
