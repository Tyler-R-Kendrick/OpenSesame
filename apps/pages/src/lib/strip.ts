import { type RefCallback, useCallback, useEffect, useRef } from "react";

/**
 * A strip must never hide its own selected item (DESIGN.md § Touch).
 *
 * Tabs scroll sideways once they outgrow a phone, and a selected tab far
 * enough along opens partly off the edge. This scrolls the strip — and only
 * the strip. `scrollIntoView` scrolls every scrollable ancestor too, so one
 * over-wide row anywhere in the section dragged the whole page sideways with
 * it, and the section opened with its own title cut in half.
 */
export function revealInStrip(item: HTMLElement, gutter = 16): void {
  const strip = item.parentElement;
  if (!strip || strip.scrollWidth <= strip.clientWidth) return;
  const box = strip.getBoundingClientRect();
  const own = item.getBoundingClientRect();
  if (own.left < box.left + gutter) {
    strip.scrollLeft -= box.left + gutter - own.left;
  } else if (own.right > box.right - gutter) {
    strip.scrollLeft += own.right - (box.right - gutter);
  }
}

/**
 * A ref for one tab: while it is current, its strip keeps it in view. `also`
 * is another callback ref on the same element (a guide target); the merged
 * ref is stable while it is, so React never detaches and re-attaches the tab
 * on a re-render — an inline merge did, and re-mounted the guide target each
 * time.
 */
export function useStripItem<T extends HTMLElement>(
  current: boolean,
  also?: (element: T | null) => void,
): RefCallback<T> {
  const node = useRef<T | null>(null);
  useEffect(() => {
    const item = node.current;
    const strip = item?.parentElement;
    if (!current || !item || !strip) return;
    revealInStrip(item);
    // Tabs a capability contributes arrive after the first paint and push
    // the current one along; so does a strip that changes width on rotate.
    const again = () => revealInStrip(item);
    const added =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(again);
    added?.observe(strip, { childList: true });
    const resized =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(again);
    resized?.observe(strip);
    return () => {
      added?.disconnect();
      resized?.disconnect();
    };
  }, [current]);
  return useCallback(
    (element: T | null) => {
      node.current = element;
      also?.(element);
    },
    [also],
  );
}
