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
  /** RGB key the atlas was baked with — rebuild when theme ink changes. */
  atlasInk?: string;
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
