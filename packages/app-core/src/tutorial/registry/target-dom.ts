import type { GuideTargetId } from "@opensesame/guide-lang";

/**
 * The attribute a bound element carries, a space-separated list of the target
 * ids it answers to. Nothing in the app reads it: resolution is the registry's
 * and only the registry's. It exists so a real-browser run can ask the page
 * which element an id stands for, instead of trusting the ring a tour drew.
 */
export const GUIDE_TARGETS_ATTRIBUTE = "data-guide-targets";

export function markBound(element: HTMLElement, id: GuideTargetId): void {
  const held = (element.getAttribute(GUIDE_TARGETS_ATTRIBUTE) ?? "")
    .split(" ")
    .filter(Boolean);
  if (!held.includes(id)) {
    element.setAttribute(GUIDE_TARGETS_ATTRIBUTE, [...held, id].join(" "));
  }
}

export function markUnbound(element: HTMLElement, id: GuideTargetId): void {
  const left = (element.getAttribute(GUIDE_TARGETS_ATTRIBUTE) ?? "")
    .split(" ")
    .filter((held) => held !== "" && held !== id);
  if (left.length === 0) element.removeAttribute(GUIDE_TARGETS_ATTRIBUTE);
  else element.setAttribute(GUIDE_TARGETS_ATTRIBUTE, left.join(" "));
}

/**
 * Whether a mounted element can actually be pointed at.
 *
 * Several controls exist twice — the vault filters are chips on a phone and
 * rail rows on a desktop — and only one copy can hold a target, because an id
 * binds to exactly one element. The other copy is still in the document, just
 * hidden by a media query, so registration alone would tell a model that an
 * invisible control is available and let it highlight a zero-box element.
 *
 * The check walks the ancestor chain for `display: none` / `visibility:
 * hidden` rather than measuring a box: layout is what jsdom does not have, and
 * a rule that behaved differently under test than in a browser would be worse
 * than no rule. A style the cascade never applied reads as visible, which is
 * the honest answer for a document that was never laid out.
 */
export function isPointable(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  let node: HTMLElement | null = element;
  while (node) {
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    node = node.parentElement;
  }
  return true;
}
