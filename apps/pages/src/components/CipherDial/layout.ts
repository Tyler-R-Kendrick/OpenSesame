import {
  B64,
  LETTERS,
  PLAIN,
  RING_CIPHER,
  RING_COUNT,
  WEIGHTS,
} from "./constants.js";
import { mulberry32 } from "./rng.js";

export type QuietRect = { x: number; y: number; w: number; h: number };

export type RingSpec = {
  i: number;
  r: number;
  N: number;
  pa: number;
  fs: number;
  cipher: string[];
  plain: string[];
  letter: string;
  isTick: boolean;
  jt: number;
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
  k: number;
  from: number;
  to: number;
  t0: number;
  dur: number;
  dir: number;
  period: number;
  next: number;
  rand: () => number;
  alpha: number;
  dirty: boolean;
  atlas?: Map<string, HTMLCanvasElement>;
  spin?: (u: number) => number;
  lastK?: number;
  lastLit?: number;
};

export type DialLayout = {
  w: number;
  h: number;
  cx: number;
  cy: number;
  R0: number;
  dr: number;
  fs: number;
  idx: number;
  order: number;
  outer: number;
  rings: RingSpec[];
  quiet: QuietRect[];
  narrow: boolean;
};

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
  const quiet: QuietRect[] = [card];
  if (notes) quiet.push(notes);
  if (narrow && notes) {
    /* notes stack below card on narrow — already in quiet */
  }

  let cx: number;
  let cy: number;
  let R0: number;
  let dr: number;
  let fs: number;
  let idx: number;
  let order: number;

  if (!narrow && notes) {
    cx = notes.x;
    dr = Math.min(21, Math.max(16, h * 0.023));
    R0 = Math.max(96, h * 0.11);
    cy = h - 30;
    fs = Math.min(12.5, dr * 0.6);
    idx = -Math.PI / 2;
    order = -1;
  } else if (!narrow) {
    cx = w / 2;
    cy = h / 2;
    R0 = Math.hypot(card.w, card.h) / 2 + 20;
    dr = Math.min(12, (h - 14 - (cy + R0)) / (RING_COUNT - 0.4));
    fs = Math.min(10, dr * 0.85);
    idx = Math.PI / 2;
    order = 1;
  } else {
    const bottom = Math.max(...quiet.map((q) => q.y + q.h));
    cx = -18;
    cy = Math.max(bottom + 70, h - 60);
    R0 = 62;
    dr = 16;
    fs = 10;
    idx = 0;
    order = 1;
  }

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
  rings.forEach((q) => {
    q.from = q.to = q.k;
  });

  const outer = R0 + (RING_COUNT - 1) * dr;
  return {
    w,
    h,
    cx,
    cy,
    R0,
    dr,
    fs,
    idx,
    order,
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
