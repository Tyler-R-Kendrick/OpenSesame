import type { DecryptRun } from "./cipher.js";
import { slotState } from "./cipher.js";
import {
  ALPHA_LEVELS,
  DRAW_CALIBRATION,
  type DrawCalibration,
  FONT_FAMILY,
  type Layout,
  type Particle,
  SMALL_GLYPH_PX,
  TAU,
  cursorBoostFor,
  inkAlpha,
  particleField,
} from "./particles-model.js";

export type DrawWordmarkOpts = {
  ctx: CanvasRenderingContext2D;
  layout: Layout;
  runs: DecryptRun[];
  timeMs: number;
  dpr: number;
  pad: number;
  inkRgb: [number, number, number];
  calibration?: DrawCalibration;
  frozenField: boolean;
  showMark: boolean;
  accent: string;
  showCursor: boolean;
};

type SmallPlateOpts = {
  ctx: CanvasRenderingContext2D;
  layout: Layout;
  runs: DecryptRun[];
  timeMs: number;
  pad: number;
  inkRgb: [number, number, number];
  calibration: DrawCalibration;
  showCursor: boolean;
};

type IconMarkOpts = {
  ctx: CanvasRenderingContext2D;
  layout: Layout;
  pad: number;
  inkRgb: [number, number, number];
  accent: string;
};

type FillBinsOpts = {
  layout: Layout;
  runs: DecryptRun[];
  timeMs: number;
  inkRgb: [number, number, number];
  calibration: DrawCalibration;
  frozenField: boolean;
  showCursor: boolean;
};

function particleAlpha(
  p: Particle,
  mk: number,
  t: number,
  timeMs: number,
  fl: number,
  calibration: DrawCalibration,
  cursorBoost: number,
): number {
  let a = particleField(p.nx, p.ny, p.off, t);
  a = calibration.floor + (1 - calibration.floor) * a;
  a = mk < 1 ? mk * (0.3 + 0.7 * a) : a;
  if (fl > 0.02) {
    const h = (p.off * 7.31 + timeMs * 0.0137) % 1;
    a = a * (1 - 0.55 * fl) + 0.55 * fl * (h < 0.5 ? 0.15 : 1) * mk;
  }
  return a * p.pa * calibration.alpha * cursorBoost;
}

function fillBins(opts: FillBinsOpts): Particle[][] {
  const { layout, runs, timeMs, inkRgb, calibration, frozenField, showCursor } =
    opts;
  const bins: Particle[][] = Array.from({ length: ALPHA_LEVELS }, () => []);
  const t = frozenField ? 2.6 : (timeMs / 1000) * 2;
  for (let si = 0; si < layout.slots.length; si += 1) {
    const q = layout.slots[si];
    if (q.space) continue;
    const st = slotState(runs, si, timeMs);
    q.cur = st;
    if (st.glyph !== q.glyph) {
      if (q.glyph !== null) q.swapAt = timeMs;
      q.glyph = st.glyph;
    }
    const M = q.masks.get(st.glyph);
    if (!M) continue;
    const fl = Math.exp(-(timeMs - q.swapAt) / 90);
    const cursorBoost = cursorBoostFor(
      inkRgb,
      calibration,
      showCursor && st.cursor,
    );
    for (let i = 0; i < q.P.length; i += 1) {
      const p = q.P[i];
      const mk = M[i] ?? 0;
      if (mk <= 0.45) continue;
      const a = particleAlpha(p, mk, t, timeMs, fl, calibration, cursorBoost);
      const lv = Math.min(ALPHA_LEVELS - 1, Math.round(a * (ALPHA_LEVELS - 1)));
      if (lv > 0) bins[lv].push(p);
    }
  }
  return bins;
}

function paintBins(
  ctx: CanvasRenderingContext2D,
  bins: Particle[][],
  inkRgb: [number, number, number],
): void {
  for (let lv = 1; lv < ALPHA_LEVELS; lv += 1) {
    const b = bins[lv];
    if (!b.length) continue;
    ctx.fillStyle = inkAlpha(inkRgb, lv / (ALPHA_LEVELS - 1));
    ctx.beginPath();
    for (const p of b) {
      const r = p.size / 2;
      if (p.sq) {
        ctx.rect(p.px - r, p.py - r, p.size, p.size);
      } else {
        ctx.moveTo(p.px + r, p.py);
        ctx.arc(p.px, p.py, r, 0, TAU);
      }
    }
    ctx.fill();
  }
}

function drawSmallPlates(opts: SmallPlateOpts): void {
  const { ctx, layout, runs, timeMs, pad, inkRgb, calibration, showCursor } =
    opts;
  ctx.font = `${layout.fpx}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const by = pad + layout.cellH / 2 + (layout.asc * layout.fpx) / 2;
  for (let si = 0; si < layout.slots.length; si += 1) {
    const q = layout.slots[si];
    if (q.space) continue;
    const st = slotState(runs, si, timeMs);
    const active = showCursor && st.cursor;
    const plateA = active
      ? calibration.smallCursorActive
      : calibration.smallCursorRest;
    ctx.fillStyle = inkAlpha(inkRgb, plateA);
    ctx.fillRect(q.x, pad, q.w, layout.cellH);
    ctx.fillStyle = `rgb(${inkRgb[0]},${inkRgb[1]},${inkRgb[2]})`;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillText(st.glyph, q.x + q.w / 2, by);
    ctx.globalCompositeOperation = "source-over";
  }
}

function drawIconMark(opts: IconMarkOpts): void {
  const { ctx, layout, pad, inkRgb, accent } = opts;
  const u = layout.cellH / 17;
  ctx.fillStyle = `rgb(${inkRgb[0]},${inkRgb[1]},${inkRgb[2]})`;
  ctx.fillRect(pad, pad, 12 * u, layout.cellH);
  ctx.fillStyle = accent;
  ctx.fillRect(pad + 14.7 * u, pad, 2.3 * u, layout.cellH);
}

export function drawWordmark(opts: DrawWordmarkOpts): void {
  const {
    ctx,
    layout,
    runs,
    timeMs,
    dpr,
    pad,
    inkRgb,
    frozenField,
    showMark,
    accent,
    showCursor,
  } = opts;
  const calibration = opts.calibration ?? DRAW_CALIBRATION;
  const glyphPx = layout.asc * layout.fpx;
  const smallMode = glyphPx < SMALL_GLYPH_PX;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (smallMode) {
    drawSmallPlates({
      ctx,
      layout,
      runs,
      timeMs,
      pad,
      inkRgb,
      calibration,
      showCursor,
    });
    if (showMark) drawIconMark({ ctx, layout, pad, inkRgb, accent });
    return;
  }

  const bins = fillBins({
    layout,
    runs,
    timeMs,
    inkRgb,
    calibration,
    frozenField,
    showCursor,
  });
  paintBins(ctx, bins, inkRgb);
  if (showMark) drawIconMark({ ctx, layout, pad, inkRgb, accent });
}
