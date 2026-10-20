import { strokeCircle, strokeRadialTicks } from "./canvas-primitives.js";
import { OUTER_BEZEL_CLEARANCE } from "./constants.js";

/** Smooth enclosing circles and fine ticks, without a compass scale or teeth. */
export function drawOrnamentOuterScale(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rb: number,
  ink: [number, number, number],
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
  strokeCircle(g, cx, cy, rb + OUTER_BEZEL_CLEARANCE, 0.1, 1, ink);
}
