import { drawRingGlyphs } from "./draw-ring-glyphs.js";
import type { DialLayout, RingSpec } from "./layout-types.js";

export { drawOverlay } from "./draw-overlay-index.js";

export function paintRingLayer(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  q: RingSpec,
  k: number,
  ink: [number, number, number],
  dpr: number,
): void {
  if (!g) return;
  drawRingGlyphs(g, layout, q, k, ink, dpr);
  q.lastK = k;
}
