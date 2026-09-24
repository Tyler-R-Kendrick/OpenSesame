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
        target.getBoundingClientRect().top - node.getBoundingClientRect().top;
      return;
    }
  }
  window.scrollBy(0, target.getBoundingClientRect().top);
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
