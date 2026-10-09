import {
  polarPoint,
  strokeCircle,
  strokeRadialTicks,
} from "./canvas-primitives.js";
import { TAU } from "./constants.js";
import { inkAlpha } from "./ink.js";

export function drawOrnamentOuterScale(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rb: number,
  ink: [number, number, number],
  fontFamily: string,
): void {
  strokeCircle(g, cx, cy, rb, 0.12, 1, ink);
  strokeCircle(g, cx, cy, rb + 3, 0.07, 1, ink);
  strokeRadialTicks({
    g,
    cx,
    cy,
    r: rb + 3,
    n: 360,
    L: 3,
    al: 0.08,
    ink,
    every: 5,
    Lmaj: 6,
  });
  strokeRadialTicks({
    g,
    cx,
    cy,
    r: rb + 3,
    n: 36,
    L: 9,
    al: 0.12,
    ink,
  });
  g.font = `7.5px ${fontFamily}`;
  g.fillStyle = inkAlpha(ink, 0.2);
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let j = 0; j < 36; j += 1) {
    const a = (j / 36) * TAU - Math.PI / 2;
    const [x, y] = polarPoint(cx, cy, rb + 18, a);
    g.save();
    g.translate(x, y);
    g.rotate(a + Math.PI / 2);
    g.fillText(String(j * 10).padStart(3, "0"), 0, 0);
    g.restore();
  }
  strokeCircle(g, cx, cy, rb + 26, 0.1, 1, ink);
  g.fillStyle = inkAlpha(ink, 0.1);
  g.beginPath();
  for (let j = 0; j < 120; j += 1) {
    const a = (j / 120) * TAU;
    const a2 = a + Math.PI / 120;
    const [x0, y0] = polarPoint(cx, cy, rb + 26, a);
    const [x1, y1] = polarPoint(cx, cy, rb + 31, a + Math.PI / 240);
    const [x2, y2] = polarPoint(cx, cy, rb + 26, a2);
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.lineTo(x2, y2);
  }
  g.fill();
}
