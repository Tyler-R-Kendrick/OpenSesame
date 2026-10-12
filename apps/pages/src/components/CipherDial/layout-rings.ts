import {
  B64,
  LETTERS,
  PLAIN,
  RING_CIPHER,
  RING_COUNT,
  WEIGHTS,
} from "./constants.js";
import type { DialGeometry } from "./layout-geometry.js";
import type { RingSpec } from "./layout-types.js";
import { mulberry32 } from "./rng.js";

export function buildRingSpecs(input: {
  w: number;
  h: number;
  geo: DialGeometry;
  nowMs: number;
  prev?: RingSpec[];
}): RingSpec[] {
  const { w, h, geo, nowMs, prev } = input;
  const { cx, cy, R0, dr, fs, order } = geo;

  const rings: RingSpec[] = LETTERS.map((letter, i) => {
    const li = order > 0 ? i : RING_COUNT - 1 - i;
    const ringLetter = LETTERS[li];
    const r = R0 + i * dr;
    const pitch = fs * 1.3 * WEIGHTS[i % WEIGHTS.length];
    const N = Math.max(12, Math.round((2 * Math.PI * r) / pitch));
    const pa = (2 * Math.PI) / N;
    const rand = mulberry32(1013 + i * 7919);
    const alpha = i % 2 ? B64 : RING_CIPHER;
    const cipher = Array.from(
      { length: N },
      () => alpha[Math.floor(rand() * alpha.length)],
    );
    const plain = Array.from(
      { length: N },
      (_, j) => PLAIN[(j * 3 + i) % PLAIN.length],
    );
    const isTick = ringLetter === " ";
    let jt = plain.indexOf(ringLetter);
    if (jt < 0) jt = Math.floor(rand() * N);
    const m = fs + 4;
    const bx0 = Math.max(0, Math.floor(cx - r - m));
    const by0 = Math.max(0, Math.floor(cy - r - m));
    const bx1 = Math.min(w, Math.ceil(cx + r + m));
    const by1 = Math.min(h, Math.ceil(cy + r + m));
    const old = prev?.[i];
    const wgt = WEIGHTS[i % WEIGHTS.length];
    const ringFs = fs * wgt;
    const alphaInk = (0.13 + 0.06 * ((wgt - 0.78) / 0.38)) * (1 - i * 0.02);
    return {
      i,
      r,
      N,
      pa,
      fs: ringFs,
      cipher,
      plain,
      letter: ringLetter,
      isTick,
      jt,
      bx0,
      by0,
      bx1,
      by1,
      k: old ? ((Math.round(old.to) % N) + N) % N : Math.floor(rand() * N),
      from: 0,
      to: 0,
      t0: -1,
      dur: 140,
      dir: i % 3 === 1 ? -1 : 1,
      period: 700 + rand() * 1900,
      next: nowMs + 300 + rand() * 1600,
      rand,
      dirty: true,
      alpha: alphaInk,
    };
  });
  for (const q of rings) {
    q.from = q.to = q.k;
  }
  return rings;
}
