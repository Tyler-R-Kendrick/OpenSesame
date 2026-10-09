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
    if (!("ResizeObserver" in globalThis)) {
      const onResize = () => relayout();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const ro = new ResizeObserver(() => relayout());
    ro.observe(pane);
    if (cardRef.current) ro.observe(cardRef.current);
    if (notesRef.current) ro.observe(notesRef.current);
    return () => ro.disconnect();
  }, [cardRef, notesRef, paneRef, relayout]);
}
