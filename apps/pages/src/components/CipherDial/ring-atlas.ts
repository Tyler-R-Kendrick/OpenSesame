import { RING_FONT } from "./constants.js";
import { inkAlpha } from "./ink.js";
import type { RingSpec } from "./layout-types.js";

export function ensureRingAtlas(
  q: RingSpec,
  ink: [number, number, number],
  dpr: number,
): void {
  if (q.atlas) return;
  const font = `${q.fs}px ${RING_FONT}`;
  const box = Math.ceil(q.fs * 1.3);
  const half = box / 2;
  q.atlas = new Map();
  for (const ch of new Set(q.cipher)) {
    const c = document.createElement("canvas");
    c.width = Math.ceil(box * dpr);
    c.height = Math.ceil(box * dpr);
    const x = c.getContext("2d");
    if (!x) continue;
    x.scale(dpr, dpr);
    x.font = font;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillStyle = inkAlpha(ink, q.alpha);
    x.fillText(ch, half, half);
    q.atlas.set(ch, c);
  }
}
