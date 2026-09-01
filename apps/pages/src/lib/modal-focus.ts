import type { RefObject } from "react";
import { useEffect } from "react";

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
      if (event.key === "Escape") {
        // Support sits above ceremony sheets. Both listen on window; without
        // this, Escape would close every open sheet at once.
        const sheets = document.querySelectorAll(".sheet");
        const top = sheets.item(sheets.length - 1);
        if (container.current !== top) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        container.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((element) => element.tabIndex >= 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (!container.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (trigger instanceof HTMLElement) trigger.focus();
    };
  }, [close, container, initial, open]);
}
