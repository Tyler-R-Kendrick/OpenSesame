import { computeDialGeometry } from "./layout-geometry.js";
import { buildRingSpecs } from "./layout-rings.js";
import type { DialLayout, QuietRect, RingSpec } from "./layout-types.js";

export type { DialLayout, QuietRect, RingSpec } from "./layout-types.js";

export function computeDialLayout(input: {
  w: number;
  h: number;
  card: QuietRect;
  notes: QuietRect | null;
  narrow: boolean;
  nowMs: number;
  prev?: RingSpec[];
}): DialLayout {
  const { w, h, card, notes, narrow, nowMs, prev } = input;
  // Wide: clip rings at the notes divider in apply-dial-layout (not a quiet
  // erase — pads would eat past the column). Narrow: notes stay opaque above
  // the dial (z-index); do not quiet-mask them or the soft erase collapses the
  // corner dial to a left-edge sliver (lock-v5 mobile composition).
  const quiet: QuietRect[] = [card];

  const geo = computeDialGeometry({ w, h, card, notes, narrow, quiet });
  const rings = buildRingSpecs({ w, h, geo, nowMs, prev });
  const outer = geo.R0 + (rings.length - 1) * geo.dr;

  return {
    w,
    h,
    cx: geo.cx,
    cy: geo.cy,
    R0: geo.R0,
    dr: geo.dr,
    fs: geo.fs,
    idx: geo.idx,
    order: geo.order,
    outer,
    rings,
    quiet,
    narrow,
  };
}

export function rectRelative(pane: DOMRect, el: DOMRect): QuietRect {
  return {
    x: el.left - pane.left,
    y: el.top - pane.top,
    w: el.width,
    h: el.height,
  };
}
