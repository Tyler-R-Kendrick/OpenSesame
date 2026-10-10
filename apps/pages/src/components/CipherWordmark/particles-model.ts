import type { SlotFrame } from "./cipher.js";

export const TAU = Math.PI * 2;
export const FONT_FAMILY = '"OS Logo", ui-monospace, monospace';
export const PARTICLE_SEED = 1337;
export const ALPHA_LEVELS = 24;
export const SMALL_GLYPH_PX = 14;

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

export function lcg(seed: number): () => number {
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

export function inkAlpha(inkRgb: [number, number, number], a: number): string {
  return `rgba(${inkRgb[0]},${inkRgb[1]},${inkRgb[2]},${a})`;
}

export function readInkRgb(root: HTMLElement): [number, number, number] {
  const raw = getComputedStyle(root).color;
  const m = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return [0, 0, 0];
}

/** The mark's slit: the greyscale system's `--mark-slit`, never a hue. */
export function readAccent(root: HTMLElement): string {
  const style = getComputedStyle(root);
  return (
    style.getPropertyValue("--mark-slit").trim() ||
    style.getPropertyValue("--accent").trim() ||
    "#8f8f8f"
  );
}
