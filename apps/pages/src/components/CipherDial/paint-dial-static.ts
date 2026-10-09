import { drawOverlay, paintRingLayer } from "./draw-rings.js";
import type { DialLayout, RingSpec } from "./layout-types.js";

export function paintDialStaticFrame(input: {
  layout: DialLayout;
  rings: RingSpec[];
  lit: number;
  ink: [number, number, number];
  ringCanvasRefs: Map<number, HTMLCanvasElement>;
  overlay: HTMLCanvasElement | null;
}): void {
  const { layout, rings, lit, ink, ringCanvasRefs, overlay } = input;
  const d = window.devicePixelRatio || 1;
  for (const q of rings) {
    const cv = ringCanvasRefs.get(q.i);
    const g = cv?.getContext("2d");
    if (g) paintRingLayer(g, layout, q, q.to, ink, d);
  }
  const og = overlay?.getContext("2d");
  if (og) drawOverlay(og, layout, rings, lit, ink, d);
}
