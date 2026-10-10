import { RING_FONT } from "./constants.js";
import { inkAlpha } from "./ink.js";
import type { DialLayout, RingSpec } from "./layout-types.js";
import { ensureRingAtlas } from "./ring-atlas.js";

function glyphInQuiet(
  x: number,
  y: number,
  quiet: DialLayout["quiet"],
): boolean {
  return quiet.some(
    (r) => x > r.x - 6 && x < r.x + r.w + 6 && y > r.y - 6 && y < r.y + r.h + 6,
  );
}

function drawCipherSprites(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  q: RingSpec,
  base: number,
  under: number,
  ink: [number, number, number],
  dpr: number,
): void {
  const { cx, cy, quiet } = layout;
  const m = q.fs;
  const box = Math.ceil(q.fs * 1.3);
  const half = box / 2;
  ensureRingAtlas(q, ink, dpr);

  for (let j = 0; j < q.N; j += 1) {
    if (j === under) continue;
    const a = base + j * q.pa;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x = cx + ca * q.r;
    const y = cy + sa * q.r;
    if (x < q.bx0 - m || x > q.bx1 + m || y < q.by0 - m || y > q.by1 + m) {
      continue;
    }
    if (glyphInQuiet(x, y, quiet)) continue;
    const sprite = q.atlas?.get(q.cipher[j]);
    if (!sprite) continue;
    g.setTransform(
      -sa * dpr,
      ca * dpr,
      -ca * dpr,
      -sa * dpr,
      (x - q.bx0) * dpr,
      (y - q.by0) * dpr,
    );
    g.drawImage(sprite, -half, -half, box, box);
  }
  g.setTransform(dpr, 0, 0, dpr, -q.bx0 * dpr, -q.by0 * dpr);
}

function drawUnderGlyph(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  q: RingSpec,
  base: number,
  under: number,
  k: number,
  ink: [number, number, number],
): void {
  const { cx, cy } = layout;
  const a = base + under * q.pa;
  const x = cx + Math.cos(a) * q.r;
  const y = cy + Math.sin(a) * q.r;
  if (Math.abs(k - Math.round(k)) >= 0.02) {
    g.font = `${q.fs}px ${RING_FONT}`;
    g.fillStyle = inkAlpha(ink, q.alpha);
    g.translate(x, y);
    g.rotate(a + Math.PI / 2);
    g.fillText(q.cipher[under], 0, 0);
  }
}

export function drawCipherRingGlyphs(
  g: CanvasRenderingContext2D,
  layout: DialLayout,
  q: RingSpec,
  k: number,
  ink: [number, number, number],
  dpr: number,
): void {
  const { idx } = layout;
  const base = idx - k * q.pa;
  const under = ((Math.round(k) % q.N) + q.N) % q.N;
  g.textAlign = "center";
  g.textBaseline = "middle";
  drawCipherSprites(g, layout, q, base, under, ink, dpr);
  drawUnderGlyph(g, layout, q, base, under, k, ink);
}
