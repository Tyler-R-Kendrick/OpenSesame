/**
 * Bring a panel to the top of the pane that scrolls it — vertically, and
 * nothing else. `scrollIntoView` also scrolls every ancestor sideways to fit
 * the element, which is how one over-wide row dragged a whole section off
 * the side of a phone (DESIGN.md § Touch).
 */
export function scrollToPanel(target: HTMLElement): void {
  for (let node = target.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      node.scrollTop +=
        target.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        headroom(target, node);
      return;
    }
  }
  window.scrollBy(
    0,
    target.getBoundingClientRect().top - headroom(target, document.body),
  );
}

/** The gap a heading keeps under the pane's top edge. */
const BREATHING_PX = 16;

/**
 * How far below the pane's top a panel lands: its own scroll margin (or a
 * line's breathing room — flush against the edge, a heading read as cut off),
 * plus the page's jump strip where that strip sticks and would cover it.
 */
function headroom(target: HTMLElement, pane: HTMLElement): number {
  const margin =
    Number.parseFloat(getComputedStyle(target).scrollMarginTop) || BREATHING_PX;
  const strip = pane.querySelector<HTMLElement>(".page-index");
  const covered =
    strip && getComputedStyle(strip).position === "sticky"
      ? strip.getBoundingClientRect().height
      : 0;
  return margin + covered;
}

/** Resolve a `#fragment` to an element, decoding URI escapes in the id. */
export function panelFromHash(hash: string): HTMLElement | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Malformed escape — fall through with the raw fragment.
  }
  return document.getElementById(id);
}
