import type { DialLayout } from "./layout-types.js";
import { drawOrnamentHub } from "./ornament-inner.js";
import { drawOrnamentOuterScale } from "./ornament-outer.js";
import { drawOrnamentInnerRings } from "./ornament-rings.js";

export function drawOrnament(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  ink: [number, number, number],
  fontFamily: string,
): void {
  const { cx, cy, R0, dr, outer: RO } = layout;
  drawOrnamentHub(g, cx, cy, R0, ink);
  drawOrnamentInnerRings(g, cx, cy, R0, dr, ink);
  const rb = RO + dr * 0.6;
  drawOrnamentOuterScale(g, cx, cy, rb, ink, fontFamily);
}
