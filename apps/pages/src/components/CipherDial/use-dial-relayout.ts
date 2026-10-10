import { type RefObject, useCallback } from "react";
import { measureAndPaintDial } from "./apply-dial-layout.js";
import type { DialLayout } from "./layout-types.js";

export function useDialRelayout(input: {
  paneRef: RefObject<HTMLElement | null>;
  cardRef: RefObject<HTMLElement | null>;
  notesRef: RefObject<HTMLElement | null>;
  fixedRef: RefObject<HTMLCanvasElement | null>;
  overlayRef: RefObject<HTMLCanvasElement | null>;
  ringLayerRef: RefObject<HTMLDivElement | null>;
  ringCanvasRefs: RefObject<Map<number, HTMLCanvasElement>>;
  layoutRef: RefObject<DialLayout | null>;
  inkRef: RefObject<[number, number, number]>;
  onSplitX?: (x: number) => void;
}): () => void {
  const {
    paneRef,
    cardRef,
    notesRef,
    fixedRef,
    overlayRef,
    ringLayerRef,
    ringCanvasRefs,
    layoutRef,
    inkRef,
    onSplitX,
  } = input;

  return useCallback(() => {
    const pane = paneRef.current;
    const card = cardRef.current;
    if (!pane || !card) return;

    const result = measureAndPaintDial(
      {
        pane,
        card,
        notes: notesRef.current,
        ringLayer: ringLayerRef.current,
        fixed: fixedRef.current,
        overlay: overlayRef.current,
        ringCanvasRefs: ringCanvasRefs.current,
      },
      layoutRef.current?.rings,
    );
    if (!result) return;

    layoutRef.current = result.layout;
    inkRef.current = result.ink;
    onSplitX?.(result.splitX);
  }, [
    cardRef,
    fixedRef,
    inkRef,
    layoutRef,
    notesRef,
    onSplitX,
    overlayRef,
    paneRef,
    ringCanvasRefs,
    ringLayerRef,
  ]);
}
