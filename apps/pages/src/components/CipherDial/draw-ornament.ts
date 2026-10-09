import { RING_COUNT, TAU } from "./constants.js";
import { inkAlpha } from "./ink.js";
import type { DialLayout } from "./layout.js";

function point(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

function circle(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  al: number,
  lw,
  ink: [number, number, number],
): void {
  g.strokeStyle = inkAlpha(ink, al);
  g.lineWidth = lw;
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.stroke();
}

function ticks(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  n: number,
  L: number,
  al: number,
  ink: [number, number, number],
  every = 0,
  Lmaj = L * 2,
  out = 1,
): void {
  g.strokeStyle = inkAlpha(ink, al);
  g.lineWidth = 1;
  g.beginPath();
  for (let j = 0; j < n; j += 1) {
    const a = (j / n) * TAU;
    const LL = every && j % every === 0 ? Lmaj : L;
    const [x0, y0] = point(cx, cy, r, a);
    const [x1, y1] = point(cx, cy, r + LL * out, a);
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
  }
  g.stroke();
}

export function drawOrnament(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  ink: [number, number, number],
  fontFamily: string,
): void {
  const { cx, cy, R0, dr, outer: RO } = layout;
  for (let j = 0; j < 12; j += 1) {
    const a = (j / 12) * TAU;
    g.beginPath();
    g.strokeStyle = inkAlpha(ink, 0.09);
    g.arc(cx + Math.cos(a) * 13, cy + Math.sin(a) * 13, 13, 0, TAU);
    g.stroke();
  }
  circle(g, cx, cy, 28, 0.12, 1, ink);
  circle(g, cx, cy, 4, 0.3, 1, ink);
  g.strokeStyle = inkAlpha(ink, 0.14);
  g.beginPath();
  g.moveTo(cx - R0 * 0.62, cy);
  g.lineTo(cx + R0 * 0.62, cy);
  g.moveTo(cx, cy - R0 * 0.62);
  g.lineTo(cx, cy + R0 * 0.62);
  g.stroke();

  const h0 = R0 * 0.48;
  const h1 = R0 * 0.6;
  circle(g, cx, cy, h0, 0.08, 1, ink);
  circle(g, cx, cy, h1, 0.08, 1, ink);
  ticks(g, cx, cy, h0, 180, h1 - h0, 0.07, ink);

  g.fillStyle = inkAlpha(ink, 0.16);
  for (let j = 0; j < 90; j += 1) {
    const [x, y] = point(cx, cy, R0 * 0.72, (j / 90) * TAU);
    g.beginPath();
    g.arc(x, y, j % 5 ? 0.8 : 1.4, 0, TAU);
    g.fill();
  }

  circle(g, cx, cy, R0 - dr * 0.55, 0.12, 1, ink);
  circle(g, cx, cy, R0 - dr * 0.55 - 2.5, 0.07, 1, ink);
  for (let i = 0; i < RING_COUNT - 1; i += 1) {
    const rs = R0 + (i + 0.5) * dr;
    if (i % 3 === 2) {
      circle(g, cx, cy, rs - 1.5, 0.08, 1, ink);
      circle(g, cx, cy, rs + 1.5, 0.08, 1, ink);
    } else {
      circle(g, cx, cy, rs, i % 2 ? 0.05 : 0.07, 1, ink);
    }
    if (i % 2 === 0) {
      ticks(g, cx, cy, rs, 120, 2.5, 0.08, ink, 6, 5, i % 4 === 0 ? 1 : -1);
    }
  }

  const rb = RO + dr * 0.6;
  circle(g, cx, cy, rb, 0.12, 1, ink);
  circle(g, cx, cy, rb + 3, 0.07, 1, ink);
  ticks(g, cx, cy, rb + 3, 360, 3, 0.08, ink, 5, 6);
  ticks(g, cx, cy, rb + 3, 36, 9, 0.12, ink);
  g.font = `7.5px ${fontFamily}`;
  g.fillStyle = inkAlpha(ink, 0.2);
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let j = 0; j < 36; j += 1) {
    const a = (j / 36) * TAU - Math.PI / 2;
    const [x, y] = point(cx, cy, rb + 18, a);
    g.save();
    g.translate(x, y);
    g.rotate(a + Math.PI / 2);
    g.fillText(String(j * 10).padStart(3, "0"), 0, 0);
    g.restore();
  }
  circle(g, cx, cy, rb + 26, 0.1, 1, ink);
  g.fillStyle = inkAlpha(ink, 0.1);
  g.beginPath();
  for (let j = 0; j < 120; j += 1) {
    const a = (j / 120) * TAU;
    const a2 = a + Math.PI / 120;
    const [x0, y0] = point(cx, cy, rb + 26, a);
    const [x1, y1] = point(cx, cy, rb + 31, a + Math.PI / 240);
    const [x2, y2] = point(cx, cy, rb + 26, a2);
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.lineTo(x2, y2);
  }
  g.fill();
}
