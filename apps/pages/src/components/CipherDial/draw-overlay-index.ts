import { RING_FONT } from "./constants.js";
import { inkAlpha } from "./ink.js";
import type { DialLayout, RingSpec } from "./layout-types.js";

function drawIndexNeedle(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  lit: number,
  ink: [number, number, number],
): void {
  const { cx, cy, idx, fs, outer } = layout;
  const ca = Math.cos(idx);
  const sa = Math.sin(idx);
  const r0 = layout.R0 - layout.dr * 0.7;
  const r1 = outer + layout.dr * 0.6 + 26;
  const half = fs * 0.9;
  const px = -sa * half;
  const py = ca * half;
  g.strokeStyle = inkAlpha(ink, 0.18 + 0.6 * lit);
  g.lineWidth = 1;
  g.beginPath();
  for (const s of [-1, 1]) {
    g.moveTo(Math.round(cx + ca * r0 + px * s) + 0.5, cy + sa * r0 + py * s);
    g.lineTo(
      Math.round(cx + ca * (r1 + 10) + px * s) + 0.5,
      cy + sa * (r1 + 10) + py * s,
    );
  }
  g.stroke();
  g.fillStyle = inkAlpha(ink, 0.24 + 0.6 * lit);
  g.beginPath();
  const tx = cx + ca * (r1 + 12);
  const ty = cy + sa * (r1 + 12);
  g.moveTo(tx, ty);
  g.lineTo(tx + ca * 7 + px * 0.6, ty + sa * 7 + py * 0.6);
  g.lineTo(tx + ca * 7 - px * 0.6, ty + sa * 7 - py * 0.6);
  g.closePath();
  g.fill();
}

function drawPlainLabels(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  rings: RingSpec[],
  lit: number,
  ink: [number, number, number],
): void {
  const { cx, cy, idx, fs } = layout;
  const ca = Math.cos(idx);
  const sa = Math.sin(idx);
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const q of rings) {
    const k = q.lastK ?? q.to;
    if (Math.abs(k - Math.round(k)) >= 0.02) continue;
    const under = ((Math.round(k) % q.N) + q.N) % q.N;
    const x = cx + ca * q.r;
    const y = cy + sa * q.r;
    if (q.isTick) {
      const L = 3 + 2 * lit;
      g.strokeStyle = inkAlpha(ink, 0.3 + 0.6 * lit);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x - L, Math.round(y) + 0.5);
      g.lineTo(x + L, Math.round(y) + 0.5);
      g.stroke();
      continue;
    }
    g.font = `${fs * (1 + 0.12 * lit)}px ${RING_FONT}`;
    g.fillStyle = inkAlpha(ink, 0.55 + 0.42 * lit);
    g.fillText(q.plain[under], x, y);
  }
}

export function drawOverlay(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  rings: RingSpec[],
  lit: number,
  ink: [number, number, number],
  dpr: number,
): void {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, layout.w, layout.h);
  drawIndexNeedle(g, layout, lit, ink);
  drawPlainLabels(g, layout, rings, lit, ink);
}
