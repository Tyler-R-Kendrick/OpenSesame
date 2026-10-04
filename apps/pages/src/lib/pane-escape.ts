import { useEffect } from "react";
import { landFocus } from "./focus.js";
import {
  capturingKeys,
  contextMenuOpen,
  statusBubbleOpen,
} from "./keymap-targets.js";

const PANES =
  '.sheet, [role="dialog"], [role="tabpanel"], [role="menu"], .account-switcher__menu, .project-switcher__menu, .panel, .vault__detail, .vault__list, main';
const DELEGATED =
  '.sheet, [role="dialog"], [role="menu"], .account-switcher__menu, .project-switcher__menu';

function textEntry(element: HTMLElement): boolean {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      ![
        "button",
        "submit",
        "reset",
        "checkbox",
        "radio",
        "file",
        "range",
        "color",
      ].includes(element.type)) ||
    element.isContentEditable ||
    element.closest(
      '[contenteditable="true"], [contenteditable=""], [role="textbox"]',
    ) !== null
  );
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function plainEscape(event: KeyboardEvent): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.isComposing &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/** Escape climbs one focus level; it never turns an edit into an implicit save. */
export function handlePaneEscape(event: KeyboardEvent): boolean {
  if (!plainEscape(event) || !(event.target instanceof HTMLElement))
    return false;
  if (contextMenuOpen() || statusBubbleOpen()) return false;
  const target = event.target;
  // A key-capture field ends its own recording on Escape.
  if (capturingKeys(target)) return false;
  const pane = target.closest<HTMLElement>(PANES) ?? target.closest("form");
  if (!pane) return false;
  if (event.repeat) {
    consume(event);
    return true;
  }
  if (textEntry(target)) {
    consume(event);
    if (!pane.hasAttribute("tabindex")) pane.tabIndex = -1;
    landFocus(pane);
    return true;
  }
  if (target !== pane) return false;
  return closePane(event, pane);
}

/** Escape on the pane itself: close it, or leave Escape to a live tour. */
function closePane(event: KeyboardEvent, pane: HTMLElement): boolean {
  // Modal/menu owners retain their existing close, nesting and focus-return rules.
  if (pane.matches(DELEGATED)) return true;
  // A pane with nothing to close has nothing to take Escape for: while a
  // tutorial is live the key is the tour's to leave by, not ours to swallow.
  const close = closeControl(pane);
  if (!close && document.querySelector(".coach") !== null) return false;
  consume(event);
  close?.click();
  return true;
}

/** The pane's own close control, when it is there and can be pressed. */
function closeControl(pane: HTMLElement): HTMLElement | null {
  const close = [
    ...pane.querySelectorAll<HTMLElement>("[data-pane-close]"),
  ].find(
    (control) => (control.closest(PANES) ?? control.closest("form")) === pane,
  );
  if (
    close &&
    !close.matches(':disabled, [aria-disabled="true"]') &&
    !close.closest('[hidden], [aria-hidden="true"]')
  )
    return close;
  return null;
}

/** Also covers front-door forms, which are outside the unlocked shell keymap. */
export function usePaneEscape(): void {
  useEffect(() => {
    window.addEventListener("keydown", handlePaneEscape, true);
    return () => window.removeEventListener("keydown", handlePaneEscape, true);
  }, []);
}
