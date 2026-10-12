import {
  polarPoint,
  strokeCircle,
  strokeRadialTicks,
} from "./canvas-primitives.js";
import { TAU } from "./constants.js";
import { inkAlpha } from "./ink.js";

export function drawOrnamentHub(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R0: number,
  ink: [number, number, number],
): void {
  for (let j = 0; j < 12; j += 1) {
    const a = (j / 12) * TAU;
    g.beginPath();
    g.strokeStyle = inkAlpha(ink, 0.09);
    g.arc(cx + Math.cos(a) * 13, cy + Math.sin(a) * 13, 13, 0, TAU);
    g.stroke();
  }
  strokeCircle(g, cx, cy, 28, 0.12, 1, ink);
  strokeCircle(g, cx, cy, 4, 0.3, 1, ink);
  g.strokeStyle = inkAlpha(ink, 0.14);
  g.beginPath();
  g.moveTo(cx - R0 * 0.62, cy);
  g.lineTo(cx + R0 * 0.62, cy);
  g.moveTo(cx, cy - R0 * 0.62);
  g.lineTo(cx, cy + R0 * 0.62);
  g.stroke();

  const h0 = R0 * 0.48;
  const h1 = R0 * 0.6;
  strokeCircle(g, cx, cy, h0, 0.08, 1, ink);
  strokeCircle(g, cx, cy, h1, 0.08, 1, ink);
  strokeRadialTicks({
    g,
    cx,
    cy,
    r: h0,
    n: 180,
    L: h1 - h0,
    al: 0.07,
    ink,
  });

  g.fillStyle = inkAlpha(ink, 0.16);
  for (let j = 0; j < 90; j += 1) {
    const [x, y] = polarPoint(cx, cy, R0 * 0.72, (j / 90) * TAU);
    g.beginPath();
    g.arc(x, y, j % 5 ? 0.8 : 1.4, 0, TAU);
    g.fill();
  }
}
