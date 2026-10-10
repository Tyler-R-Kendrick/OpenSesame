import type { SlotFrame } from "./cipher.js";

export const TAU = Math.PI * 2;
export const FONT_FAMILY = '"OS Logo", ui-monospace, monospace';
export const PARTICLE_SEED = 1337;
export const ALPHA_LEVELS = 24;

/**
 * One plate grid, three renderings by em size (DESIGN.md § Mark): letters
 * alone under 16px, a solid plate with the letter cut out from 16 to 48px, a
 * field of particles with the letter cut out from 48px up. Measured on the
 * product, an 11px particle plate keeps 290 of its 1,400 cut-out pixels and
 * reads as redacted blocks, so the small tiers exist.
 */
export const TYPE_MAX_EM = 16;
export const SOLID_MAX_EM = 48;
export type WordmarkTier = "type" | "solid" | "field";

export function tierOf(em: number): WordmarkTier {
  if (em < TYPE_MAX_EM) return "type";
  if (em < SOLID_MAX_EM) return "solid";
  return "field";
}

/** The wordmark's width in ems, mark and gap included: fit a hero with it. */
export const WORDMARK_WIDTH_EM = 7.78;

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
  em: number;
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
  /** Solid-plate cursor: resting vs active plate alpha. */
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

/** The slit of light in the mark: `--mark-slit`, a grey, never a hue. */
export function readSlit(root: HTMLElement): string {
  return (
    getComputedStyle(root).getPropertyValue("--mark-slit").trim() || "#8f8f8f"
  );
}
