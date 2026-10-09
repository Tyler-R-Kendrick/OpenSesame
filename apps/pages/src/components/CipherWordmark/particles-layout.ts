import {
  DRAW_CALIBRATION,
  FONT_FAMILY,
  type Layout,
  PARTICLE_SEED,
  type Particle,
  type WordSlot,
  lcg,
} from "./particles-model.js";

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

function glyphWidthMax(
  ctx: CanvasRenderingContext2D,
  letters: string[],
): number {
  ctx.font = `100px ${FONT_FAMILY}`;
  let wMax = 0;
  for (const ch of new Set(letters.join("").replace(/ /g, ""))) {
    const t = ctx.measureText(ch);
    wMax = Math.max(
      wMax,
      (t.actualBoundingBoxLeft + t.actualBoundingBoxRight) / 100,
    );
  }
  return wMax;
}

type CellGeom = {
  em: number;
  gs: number;
  cps: number;
  cellC: number;
  cellR: number;
  cellW: number;
  cellH: number;
  markW: number;
  leading: number;
  W: number;
  H: number;
  x0: number;
  fpx: number;
  asc: number;
  gapEm: number;
};

function cellGeometry(
  ctx: CanvasRenderingContext2D,
  letters: string[],
  emPx: number,
  markGapEm: number,
  pad: number,
  includeMark: boolean,
): CellGeom {
  const { adv, asc } = measureFont(ctx);
  const gapEm = 0.28;
  const nl = letters.length;
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
  const wMax = glyphWidthMax(ctx, letters);
  const padPx = 1.6 * gs;
  const fpx = Math.min((cellW - 2 * padPx) / wMax, (cellH - 2 * padPx) / asc);
  return {
    em,
    gs,
    cps,
    cellC,
    cellR,
    cellW,
    cellH,
    markW,
    leading,
    W,
    H,
    x0,
    fpx,
    asc,
    gapEm,
  };
}

function seedParticles(geom: CellGeom, pad: number): Particle[] {
  const { gs, cellR, leading, W, x0 } = geom;
  const rand = lcg(PARTICLE_SEED);
  const cols = Math.round((W - leading) / gs) + 1;
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
      all.push({
        px: x0 + (cI + 0.5) * gs,
        py: pad + (r + 0.5) * gs,
        nx: cols > 1 ? cI / (cols - 1) : 0,
        ny: cellR > 1 ? r / (cellR - 1) : 0,
        sq: fmt === "square",
        size,
        off,
        pa: 1 - 0.22 * 0.7 * off,
      });
    }
  }
  return all;
}

function emptySlots(letters: string[], geom: CellGeom): WordSlot[] {
  const { x0, cps, gs, cellW } = geom;
  return letters.map((ch, i) => ({
    x: x0 + i * cps * gs,
    w: cellW,
    space: ch === " ",
    P: [],
    masks: new Map(),
    swapAt: -1e9,
    glyph: null,
  }));
}

function assignParticles(
  all: Particle[],
  slots: WordSlot[],
  geom: CellGeom,
): void {
  const { x0, cps, gs } = geom;
  for (const p of all) {
    const si = Math.floor((p.px - x0) / (cps * gs));
    const q = slots[si];
    if (q && !q.space && p.px >= q.x && p.px <= q.x + q.w) {
      q.P.push(p);
    }
  }
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

function sampleCoverage(
  img: Uint8ClampedArray,
  OW: number,
  OH: number,
  lx: number,
  ly: number,
  gs: number,
  SS: number,
): number {
  let sum = 0;
  let n = 0;
  const xa = Math.max(0, Math.round((lx - gs * 0.4) * SS));
  const xb = Math.min(OW, Math.round((lx + gs * 0.4) * SS));
  const ya = Math.max(0, Math.round((ly - gs * 0.4) * SS));
  const yb = Math.min(OH, Math.round((ly + gs * 0.4) * SS));
  for (let yy = ya; yy < yb; yy += 1) {
    for (let xx = xa; xx < xb; xx += 1) {
      sum += img[(yy * OW + xx) * 4 + 3] ?? 0;
      n += 1;
    }
  }
  return n ? sum / n / 255 : 0;
}

function paintGlyphMask(
  o: CanvasRenderingContext2D,
  surface: HTMLCanvasElement,
  layout: Layout,
  q: WordSlot,
  ch: string,
): Uint8ClampedArray {
  const gs = layout.gs;
  const Wc = q.w;
  const Hc = layout.cellH;
  const SS = 4;
  surface.width = Math.ceil(Wc * SS);
  surface.height = Math.ceil(Hc * SS);
  o.setTransform(SS, 0, 0, SS, 0, 0);
  o.clearRect(0, 0, Wc, Hc);
  o.fillStyle = "#000";
  o.strokeStyle = "#000";
  o.font = `${layout.fpx}px ${FONT_FAMILY}`;
  o.textAlign = "center";
  o.textBaseline = "alphabetic";
  const by = Hc / 2 + (layout.asc * layout.fpx) / 2;
  o.fillText(ch, Wc / 2, by);
  o.lineWidth = 0.4 * gs;
  o.strokeText(ch, Wc / 2, by);
  return o.getImageData(0, 0, surface.width, surface.height).data;
}

function plateMask(
  layout: Layout,
  q: WordSlot,
  ch: string,
  pad: number,
): Float32Array {
  const o = maskSurface();
  const surface = maskCanvas;
  if (!o || !surface) {
    return new Float32Array(q.P.length).fill(1);
  }
  const img = paintGlyphMask(o, surface, layout, q, ch);
  const OW = surface.width;
  const OH = surface.height;
  const gs = layout.gs;
  const SS = 4;
  const out = new Float32Array(q.P.length);
  for (let i = 0; i < q.P.length; i += 1) {
    const p = q.P[i];
    const cov = sampleCoverage(img, OW, OH, p.px - q.x, p.py - pad, gs, SS);
    out[i] = Math.max(0, 1 - cov * 1.15) ** 0.8;
  }
  return out;
}

function fillMasks(layout: Layout, pad: number): void {
  const glyphs = [
    ...new Set(layout.letters.join("").replace(/ /g, "").split("")),
  ];
  for (const q of layout.slots) {
    if (q.space) continue;
    for (const ch of glyphs) {
      q.masks.set(ch, plateMask(layout, q, ch, pad));
    }
  }
}

export function layoutWordmark(
  ctx: CanvasRenderingContext2D,
  letters: string[],
  emPx: number,
  markGapEm: number,
  pad: number,
  includeMark = false,
): Layout {
  const geom = cellGeometry(ctx, letters, emPx, markGapEm, pad, includeMark);
  const slots = emptySlots(letters, geom);
  const all = seedParticles(geom, pad);
  assignParticles(all, slots, geom);
  const layout: Layout = {
    W: geom.W,
    H: geom.H,
    gs: geom.gs,
    cellC: geom.cellC,
    cellR: geom.cellR,
    cellW: geom.cellW,
    cellH: geom.cellH,
    markW: geom.markW,
    fpx: geom.fpx,
    asc: geom.asc,
    gapEm: geom.gapEm,
    slots,
    n: all.length,
    letters,
  };
  fillMasks(layout, pad);
  return layout;
}
