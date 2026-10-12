import { TAU } from "./constants.js";
import { inkAlpha } from "./ink.js";

export function polarPoint(
  cx: number,
  cy: number,
  r: number,
  a: number,
): [number, number] {
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

export function strokeCircle(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  al: number,
  lw: number,
  ink: [number, number, number],
): void {
  g.strokeStyle = inkAlpha(ink, al);
  g.lineWidth = lw;
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.stroke();
}

export type RadialTicksOpts = {
  g: CanvasRenderingContext2D;
  cx: number;
  cy: number;
  r: number;
  n: number;
  L: number;
  al: number;
  ink: [number, number, number];
  every?: number;
  Lmaj?: number;
  out?: number;
};

export function strokeRadialTicks(opts: RadialTicksOpts): void {
  const {
    g,
    cx,
    cy,
    r,
    n,
    L,
    al,
    ink,
    every = 0,
    Lmaj = L * 2,
    out = 1,
  } = opts;
  g.strokeStyle = inkAlpha(ink, al);
  g.lineWidth = 1;
  g.beginPath();
  for (let j = 0; j < n; j += 1) {
    const a = (j / n) * TAU;
    const LL = every && j % every === 0 ? Lmaj : L;
    const [x0, y0] = polarPoint(cx, cy, r, a);
    const [x1, y1] = polarPoint(cx, cy, r + LL * out, a);
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
  }
  g.stroke();
}
