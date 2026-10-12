import { inkAlpha } from "./ink.js";
import type { DialLayout, RingSpec } from "./layout-types.js";

export function drawTickRingGlyphs(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  q: RingSpec,
  k: number,
  ink: [number, number, number],
): void {
  const { cx, cy, idx } = layout;
  const base = idx - k * q.pa;
  g.strokeStyle = inkAlpha(ink, q.alpha * 0.9);
  g.lineWidth = 1;
  g.beginPath();
  for (let j = 0; j < q.N; j += 1) {
    const a = base + j * q.pa;
    const L = j % 4 ? 3 : 6;
    g.moveTo(
      cx + Math.cos(a) * (q.r - L / 2),
      cy + Math.sin(a) * (q.r - L / 2),
    );
    g.lineTo(
      cx + Math.cos(a) * (q.r + L / 2),
      cy + Math.sin(a) * (q.r + L / 2),
    );
  }
  g.stroke();
}
