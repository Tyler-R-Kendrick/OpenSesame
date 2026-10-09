import type { DecryptRun, SlotFrame } from "./cipher.js";
import { slotState } from "./cipher.js";

const TAU = Math.PI * 2;
const FONT_FAMILY = '"OS Logo", ui-monospace, monospace';
const PARTICLE_SEED = 1337;
const ALPHA_LEVELS = 24;
const SMALL_GLYPH_PX = 14;

export type Particle = {
  px: number;
  py: number;
  nx: number;
  ny: number;
  sq: boolean;
  size: number;
  off: number;
  pa: number;
};

export type WordSlot = {
  x: number;
  w: number;
  space: boolean;
  P: Particle[];
  masks: Map<string, Float32Array>;
  swapAt: number;
  glyph: string | null;
  cur?: SlotFrame;
};

export type Layout = {
  W: number;
  H: number;
  gs: number;
  cellC: number;
  cellR: number;
  cellW: number;
  cellH: number;
  markW: number;
  fpx: number;
  asc: number;
  gapEm: number;
  slots: WordSlot[];
  n: number;
  letters: string[];
};

export type DrawCalibration = {
  dmin: number;
  dmax: number;
  floor: number;
  alpha: number;
  /**
   * Multiplier on particle alpha for the active decrypt cell (brightness
   * cursor — never a stroked frame). Light theme (dark ink): denser plate.
   * Dark theme (light ink): slightly stronger so the plate still reads at 1×.
   */
  cursorBoostLight: number;
  cursorBoostDark: number;
  /** Small solid-plate cursor: resting vs active plate alpha. */
  smallCursorRest: number;
  smallCursorActive: number;
};

export const DRAW_CALIBRATION: DrawCalibration = {
  dmin: 0.52,
  dmax: 0.82,
  floor: 0.5,
  alpha: 0.92,
  cursorBoostLight: 1.35,
  cursorBoostDark: 1.48,
  smallCursorRest: 0.88,
  smallCursorActive: 1,
};

/** Light ink on a dark surface → dark theme. */
export function isDarkInk(inkRgb: [number, number, number]): boolean {
  return (inkRgb[0] + inkRgb[1] + inkRgb[2]) / 3 > 140;
}

export function cursorBoostFor(
  inkRgb: [number, number, number],
  calibration: DrawCalibration,
  active: boolean,
): number {
  if (!active) return 1;
  return isDarkInk(inkRgb)
    ? calibration.cursorBoostDark
    : calibration.cursorBoostLight;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 0x3c6ef35f) >>> 0;
    return state / 0xffffffff;
  };
}

export function particleField(
  nx: number,
  ny: number,
  off: number,
  t: number,
): number {
  const sway = 0.14 * Math.sin(0.8 * t + off * TAU + 4 * ny);
  const o = ny * 5 - t * 0.26 + off * 5 + sway + 0.8 * nx;
  const s = o - Math.floor(o);
  const flake = s < 0.4 ? 1 - s / 0.4 : 0;
  const band = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(3 * nx - 0.5 * t)) ** 2;
  return 0.14 + 0.86 * band * flake ** 1.8;
}

function measureFont(ctx: CanvasRenderingContext2D): {
  adv: number;
  asc: number;
} {
  ctx.font = `100px ${FONT_FAMILY}`;
  const adv = ctx.measureText("0").width / 100;
  const asc =
    Math.max(
      ctx.measureText("0PEN").actualBoundingBoxAscent,
      ctx.measureText("F").actualBoundingBoxAscent,
    ) / 100;
  return { adv, asc };
}

export function layoutWordmark(
  ctx: CanvasRenderingContext2D,
  letters: string[],
  emPx: number,
  markGapEm: number,
  pad: number,
  includeMark = false,
): Layout {
  const { adv, asc } = measureFont(ctx);
  const gapEm = 0.28;
  const nl = letters.length;
  const units = asc * 1.25 + gapEm + nl * adv;
  const em = emPx > 0 ? emPx : 16;
  const rowsCap = 16;
  const gs = (asc * em) / rowsCap;
  const cps = Math.max(7, Math.round((adv * em) / gs));
  const cellC = cps - 1;
  const cellR = rowsCap + 4;
  const cellW = cellC * gs;
  const cellH = cellR * gs;
  const markW = includeMark ? cellH : 0;
  const leading = includeMark ? markW + gapEm * em : markGapEm * em;
  const W = leading + nl * cps * gs - gs;
  const H = cellH;
  const x0 = pad + leading;

  const m = ctx;
  m.font = `100px ${FONT_FAMILY}`;
  let wMax = 0;
  for (const ch of new Set(letters.join("").replace(/ /g, ""))) {
    const t = m.measureText(ch);
    wMax = Math.max(
      wMax,
      (t.actualBoundingBoxLeft + t.actualBoundingBoxRight) / 100,
    );
  }
  const padPx = 1.6 * gs;
  const fpx = Math.min((cellW - 2 * padPx) / wMax, (cellH - 2 * padPx) / asc);

  const rand = lcg(PARTICLE_SEED);
  const cols = Math.round((W - leading) / gs) + 1;
  const slots: WordSlot[] = letters.map((ch, i) => ({
    x: x0 + i * cps * gs,
    w: cellW,
    space: ch === " ",
    P: [],
    masks: new Map(),
    swapAt: -1e9,
    glyph: null,
  }));

  const all: Particle[] = [];
  for (let r = 0; r < cellR; r += 1) {
    for (let cI = 0; cI < cols; cI += 1) {
      const fmt = ["dot", "dot", "square"][Math.floor(rand() * 3)] ?? "dot";
      const big = rand() < 0.07;
      const u0 = rand();
      const size = big
        ? gs * (0.86 + 0.1 * u0)
        : gs *
          (DRAW_CALIBRATION.dmin +
            (DRAW_CALIBRATION.dmax - DRAW_CALIBRATION.dmin) * u0);
      rand();
      rand();
      const off = rand();
      const px = x0 + (cI + 0.5) * gs;
      const py = pad + (r + 0.5) * gs;
      all.push({
        px,
        py,
        nx: cols > 1 ? cI / (cols - 1) : 0,
        ny: cellR > 1 ? r / (cellR - 1) : 0,
        sq: fmt === "square",
        size,
        off,
        pa: 1 - 0.22 * 0.7 * off,
      });
    }
  }

  for (const p of all) {
    const si = Math.floor((p.px - x0) / (cps * gs));
    const q = slots[si];
    if (q && !q.space && p.px >= q.x && p.px <= q.x + q.w) {
      q.P.push(p);
    }
  }

  const glyphs = [...new Set(letters.join("").replace(/ /g, "").split(""))];
  const layout: Layout = {
    W,
    H,
    gs,
    cellC,
    cellR,
    cellW,
    cellH,
    markW,
    fpx,
    asc,
    gapEm,
    slots,
    n: all.length,
    letters,
  };

  for (const q of slots) {
    if (!q.space) {
      for (const ch of glyphs) {
        q.masks.set(ch, plateMask(ctx, layout, q, ch, pad));
      }
    }
  }

  return layout;
}

let maskCanvas: HTMLCanvasElement | null = null;
let maskCtx: CanvasRenderingContext2D | null = null;

function maskSurface(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!maskCanvas) {
    maskCanvas = document.createElement("canvas");
    maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
  }
  return maskCtx;
}

function plateMask(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  q: WordSlot,
  ch: string,
  pad: number,
): Float32Array {
  const o = maskSurface();
  if (!o || !maskCanvas) {
    return new Float32Array(q.P.length).fill(1);
  }
  const gs = layout.gs;
  const Wc = q.w;
  const Hc = layout.cellH;
  const SS = 4;
  maskCanvas.width = Math.ceil(Wc * SS);
  maskCanvas.height = Math.ceil(Hc * SS);
  o.setTransform(SS, 0, 0, SS, 0, 0);
  o.clearRect(0, 0, Wc, Hc);
  o.fillStyle = "#000";
  o.strokeStyle = "#000";
  o.font = `${layout.fpx}px ${FONT_FAMILY}`;
  o.textAlign = "center";
  o.textBaseline = "alphabetic";
  o.lineJoin = "round";
  const by = Hc / 2 + (layout.asc * layout.fpx) / 2;
  o.fillText(ch, Wc / 2, by);
  o.lineWidth = 0.4 * gs;
  o.strokeText(ch, Wc / 2, by);
  const img = o.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  const OW = maskCanvas.width;
  const out = new Float32Array(q.P.length);
  q.P.forEach((p, i) => {
    const lx = p.px - q.x;
    const ly = p.py - pad;
    let sum = 0;
    let n = 0;
    const xa = Math.max(0, Math.round((lx - gs * 0.4) * SS));
    const xb = Math.min(OW, Math.round((lx + gs * 0.4) * SS));
    const ya = Math.max(0, Math.round((ly - gs * 0.4) * SS));
    const yb = Math.min(maskCanvas.height, Math.round((ly + gs * 0.4) * SS));
    for (let yy = ya; yy < yb; yy += 1) {
      for (let xx = xa; xx < xb; xx += 1) {
        sum += img[(yy * OW + xx) * 4 + 3] ?? 0;
        n += 1;
      }
    }
    const cov = n ? sum / n / 255 : 0;
    out[i] = Math.max(0, 1 - cov * 1.15) ** 0.8;
  });
  return out;
}

function inkAlpha(inkRgb: [number, number, number], a: number): string {
  return `rgba(${inkRgb[0]},${inkRgb[1]},${inkRgb[2]},${a})`;
}

export function drawWordmark(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  runs: DecryptRun[],
  timeMs: number,
  dpr: number,
  pad: number,
  inkRgb: [number, number, number],
  calibration: DrawCalibration,
  frozenField: boolean,
  showMark: boolean,
  accent: string,
  showCursor: boolean,
): void {
  const bins: Particle[][] = Array.from({ length: ALPHA_LEVELS }, () => []);
  const t = frozenField ? 2.6 : (timeMs / 1000) * 2;
  const glyphPx = layout.asc * layout.fpx;
  const smallMode = glyphPx < SMALL_GLYPH_PX;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (smallMode) {
    drawSmallPlates(
      ctx,
      layout,
      runs,
      timeMs,
      pad,
      inkRgb,
      calibration,
      showCursor,
    );
    if (showMark) drawIconMark(ctx, layout, pad, inkRgb, accent);
    return;
  }

  layout.slots.forEach((q, si) => {
    if (q.space) return;
    const st = slotState(runs, si, timeMs);
    q.cur = st;
    if (st.glyph !== q.glyph) {
      if (q.glyph !== null) q.swapAt = timeMs;
      q.glyph = st.glyph;
    }
    const M = q.masks.get(st.glyph);
    if (!M) return;
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
      let a = particleField(p.nx, p.ny, p.off, t);
      a = calibration.floor + (1 - calibration.floor) * a;
      a = mk < 1 ? mk * (0.3 + 0.7 * a) : a;
      if (fl > 0.02) {
        const h = (p.off * 7.31 + timeMs * 0.0137) % 1;
        a = a * (1 - 0.55 * fl) + 0.55 * fl * (h < 0.5 ? 0.15 : 1) * mk;
      }
      a *= p.pa * calibration.alpha * cursorBoost;
      const lv = Math.min(ALPHA_LEVELS - 1, Math.round(a * (ALPHA_LEVELS - 1)));
      if (lv > 0) bins[lv].push(p);
    }
  });

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

  if (showMark) drawIconMark(ctx, layout, pad, inkRgb, accent);
}

function drawSmallPlates(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  runs: DecryptRun[],
  timeMs: number,
  pad: number,
  inkRgb: [number, number, number],
  calibration: DrawCalibration,
  showCursor: boolean,
): void {
  ctx.font = `${layout.fpx}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const by = pad + layout.cellH / 2 + (layout.asc * layout.fpx) / 2;
  for (const [si, q] of layout.slots.entries()) {
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

function drawIconMark(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  pad: number,
  inkRgb: [number, number, number],
  accent: string,
): void {
  const u = layout.cellH / 17;
  ctx.fillStyle = `rgb(${inkRgb[0]},${inkRgb[1]},${inkRgb[2]})`;
  ctx.fillRect(pad, pad, 12 * u, layout.cellH);
  ctx.fillStyle = accent;
  ctx.fillRect(pad + 14.7 * u, pad, 2.3 * u, layout.cellH);
}

export function readInkRgb(root: HTMLElement): [number, number, number] {
  const raw = getComputedStyle(root).color;
  const m = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return [0, 0, 0];
}

export function readAccent(root: HTMLElement): string {
  return (
    getComputedStyle(root).getPropertyValue("--accent").trim() || "#0d7268"
  );
}
