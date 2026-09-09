import { useEffect } from "react";
import { landFocus } from "./focus.js";

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
  const target = event.target;
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
  // Modal/menu owners retain their existing close, nesting and focus-return rules.
  if (pane.matches(DELEGATED)) return true;
  consume(event);
  closePane(pane);
  return true;
}

function closePane(pane: HTMLElement): void {
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
    close.click();
}

/** Also covers front-door forms, which are outside the unlocked shell keymap. */
export function usePaneEscape(): void {
  useEffect(() => {
    window.addEventListener("keydown", handlePaneEscape, true);
    return () => window.removeEventListener("keydown", handlePaneEscape, true);
  }, []);
}
