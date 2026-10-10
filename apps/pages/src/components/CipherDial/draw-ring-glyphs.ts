import { drawCipherRingGlyphs } from "./draw-cipher-glyphs.js";
import { drawTickRingGlyphs } from "./draw-tick-ring.js";
import type { DialLayout, RingSpec } from "./layout-types.js";

export function drawRingGlyphs(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  q: RingSpec,
  k: number,
  ink: [number, number, number],
  dpr: number,
): void {
  g.setTransform(dpr, 0, 0, dpr, -q.bx0 * dpr, -q.by0 * dpr);
  g.clearRect(q.bx0, q.by0, q.bx1 - q.bx0, q.by1 - q.by0);
  if (q.isTick) {
    drawTickRingGlyphs(g, layout, q, k, ink);
    return;
  }
  drawCipherRingGlyphs(g, layout, q, k, ink, dpr);
}
