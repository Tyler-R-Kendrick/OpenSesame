import { strokeCircle, strokeRadialTicks } from "./canvas-primitives.js";
import { RING_COUNT } from "./constants.js";

export function drawOrnamentInnerRings(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R0: number,
  dr: number,
  ink: [number, number, number],
): void {
  strokeCircle(g, cx, cy, R0 - dr * 0.55, 0.12, 1, ink);
  strokeCircle(g, cx, cy, R0 - dr * 0.55 - 2.5, 0.07, 1, ink);
  for (let i = 0; i < RING_COUNT - 1; i += 1) {
    const rs = R0 + (i + 0.5) * dr;
    if (i % 3 === 2) {
      strokeCircle(g, cx, cy, rs - 1.5, 0.08, 1, ink);
      strokeCircle(g, cx, cy, rs + 1.5, 0.08, 1, ink);
    } else {
      strokeCircle(g, cx, cy, rs, i % 2 ? 0.05 : 0.07, 1, ink);
    }
    if (i % 2 === 0) {
      strokeRadialTicks({
        g,
        cx,
        cy,
        r: rs,
        n: 120,
        L: 2.5,
        al: 0.08,
        ink,
        every: 6,
        Lmaj: 5,
        out: i % 4 === 0 ? 1 : -1,
      });
    }
  }
}
