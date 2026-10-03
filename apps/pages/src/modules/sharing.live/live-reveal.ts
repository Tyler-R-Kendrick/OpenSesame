/**
 * Bring the control that holds the keyboard into the part of its pane a person
 * can see (AGENTS.md §5: focus must be visible, not merely ringed).
 *
 * On a phone the section scrolls under the page's sticky jump strip
 * (`.page-index`), and the strip covers the pane's first rows. A control the
 * pane scrolled up beneath it is focused, ringed and unreachable by eye or
 * thumb. The shell's own jumps already leave room for the strip
 * (`lib/scroll-panel.ts`); this does the same for a landing — vertically, and
 * only as far as needed, so a control already clear of it never moves.
 */

/** Air kept between a landed control and the strip or edge it clears. */
const GAP_PX = 8;

function scroller(from: Element): HTMLElement | null {
  for (let node = from.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return null;
}

/** The bottom edge of the sticky strip where it sticks over `pane`, else the pane's top. */
function visibleTop(pane: HTMLElement): number {
  const edge = pane.getBoundingClientRect().top;
  const strip = pane.querySelector<HTMLElement>(".page-index");
  if (!strip || getComputedStyle(strip).position !== "sticky") return edge;
  return Math.max(edge, strip.getBoundingClientRect().bottom);
}

/** The lowest edge a person can see: the pane's, or the visual viewport's when a keyboard has shrunk it. */
function visibleBottom(pane: HTMLElement): number {
  const edge = pane.getBoundingClientRect().bottom;
  const viewport = window.visualViewport;
  return viewport ? Math.min(edge, viewport.offsetTop + viewport.height) : edge;
}

/** Scroll `target`'s pane, vertically, until `target` sits clear of the sticky strip and the pane's edges. */
export function revealClear(target: Element): void {
  const pane = scroller(target);
  if (!pane) return;
  const box = target.getBoundingClientRect();
  const top = visibleTop(pane) + GAP_PX;
  const bottom = visibleBottom(pane) - GAP_PX;
  if (box.top < top) pane.scrollTop -= top - box.top;
  else if (box.bottom > bottom) pane.scrollTop += box.bottom - bottom;
}
