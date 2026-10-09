import { type RefObject, useEffect } from "react";

export function useDialResize(
  paneRef: RefObject<HTMLElement | null>,
  cardRef: RefObject<HTMLElement | null>,
  notesRef: RefObject<HTMLElement | null>,
  relayout: () => void,
): void {
  useEffect(() => {
    relayout();
    const pane = paneRef.current;
    if (!pane) return;

    const cleanups: Array<() => void> = [];

    if ("ResizeObserver" in globalThis) {
      const ro = new ResizeObserver(() => relayout());
      ro.observe(pane);
      if (cardRef.current) ro.observe(cardRef.current);
      if (notesRef.current) ro.observe(notesRef.current);
      cleanups.push(() => ro.disconnect());
    } else {
      const onResize = () => relayout();
      window.addEventListener("resize", onResize);
      cleanups.push(() => window.removeEventListener("resize", onResize));
    }

    // Theme flips change --ink without a resize; rebake ring atlases.
    if (typeof MutationObserver !== "undefined") {
      const mo = new MutationObserver(() => relayout());
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "class"],
      });
      cleanups.push(() => mo.disconnect());
    }

    return () => {
      for (const stop of cleanups) stop();
    };
  }, [cardRef, notesRef, paneRef, relayout]);
}
