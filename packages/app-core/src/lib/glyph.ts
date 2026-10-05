/**
 * A glyph: the small dotted mark that stands for a person, an organization or
 * a vault where there is no room for its name (ADR 0164).
 *
 * It is drawn the way GitHub draws an identicon — a hash of the thing, folded
 * into a left-right symmetric grid — but out of braille dots, so the same mark
 * can be written in a terminal as text (`⠗⡈⢁⠺` over `⡾⢕⡪⢷`) and drawn on a
 * phone as an SVG of the very same dots. Eight columns by eight rows of dots
 * (four braille cells by two), mirrored about the vertical axis: 32 free bits
 * of pattern and one of 24 hues, enough that the vaults and accounts one
 * device holds do not collide.
 *
 * A glyph is an *address*, not a secret and not a name. It is derived from an
 * id the device already shows in the clear (a tomb id, a principal id, an
 * organization id) so it can be drawn before unlock and says nothing a sealed
 * name would. It is display only — never a check that two things are the same,
 * and never an input to authorization.
 *
 * Pure: no DOM, no storage, no clock. The golden vectors in
 * `spec/conformance/glyph-vectors.json` pin the output, because a change to
 * any step below re-draws every glyph a person has learned.
 */

import { sha256 } from "@noble/hashes/sha2";

/** Dots across and down. Even, so the mirror has no centre column. */
export const GLYPH_COLS = 8;
export const GLYPH_ROWS = 8;
/** Braille cells across and down (each cell is 2 dots wide, 4 high). */
export const GLYPH_CELL_COLS = GLYPH_COLS / 2;
export const GLYPH_CELL_ROWS = GLYPH_ROWS / 4;

const HUE_STEPS = 24;
/** The free half of the grid, before it is mirrored. */
const HALF_COLS = GLYPH_COLS / 2;
/** Fewer lit dots is a smudge, more is a block; neither tells two things apart. */
const MIN_LIT = 10;
const MAX_LIT = 22;
/** Re-draws before a sparse or dense pattern is accepted anyway. */
const MAX_DRAWS = 16;

export type GlyphKind = "vault" | "person" | "org";

export type Glyph = {
  /** The domain-separated string that was hashed. */
  readonly seed: string;
  /** `GLYPH_ROWS` rows of `GLYPH_COLS` dots, true where a dot is raised. */
  readonly dots: readonly (readonly boolean[])[];
  /** The braille text, one string per cell row. */
  readonly lines: readonly string[];
  /** 0–359 in steps of 15. Colour is a second cue, never the only one. */
  readonly hue: number;
};

/**
 * The string a glyph is drawn from. The kind keeps a vault, a person and an
 * organization that happen to share an id from sharing a face, and `v1` names
 * the algorithm, so replacing it is a visible act.
 */
export function glyphSeed(kind: GlyphKind, key: string): string {
  return `opensesame:glyph:v1:${kind}:${key}`;
}

function digest(seed: string, draw: number): Uint8Array {
  const text = draw === 0 ? seed : `${seed}\u0000${draw}`;
  return sha256(new TextEncoder().encode(text));
}

function popcount(value: number): number {
  let count = 0;
  for (let rest = value >>> 0; rest !== 0; rest &= rest - 1) count += 1;
  return count;
}

/** The dots of a braille cell, by (row, column) inside it. */
const BRAILLE_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

function cellText(
  dots: readonly (readonly boolean[])[],
  cellRow: number,
  cellCol: number,
): string {
  let bits = 0;
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      if (dots[cellRow * 4 + row]?.[cellCol * 2 + col]) {
        bits |= BRAILLE_BIT[row]?.[col] ?? 0;
      }
    }
  }
  return String.fromCodePoint(0x2800 + bits);
}

/** The same seed always yields the same glyph, on every device. */
export function glyphFor(seed: string): Glyph {
  let bytes: Uint8Array = new Uint8Array(0);
  let half = 0;
  for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
    bytes = digest(seed, draw);
    half =
      ((bytes[0] ?? 0) |
        ((bytes[1] ?? 0) << 8) |
        ((bytes[2] ?? 0) << 16) |
        ((bytes[3] ?? 0) << 24)) >>>
      0;
    const lit = popcount(half);
    if (lit >= MIN_LIT && lit <= MAX_LIT) break;
  }

  const dots: boolean[][] = [];
  for (let row = 0; row < GLYPH_ROWS; row += 1) {
    const cells: boolean[] = new Array<boolean>(GLYPH_COLS).fill(false);
    for (let col = 0; col < HALF_COLS; col += 1) {
      const on = ((half >>> (row * HALF_COLS + col)) & 1) === 1;
      cells[col] = on;
      cells[GLYPH_COLS - 1 - col] = on;
    }
    dots.push(cells);
  }

  const lines: string[] = [];
  for (let cellRow = 0; cellRow < GLYPH_CELL_ROWS; cellRow += 1) {
    let line = "";
    for (let cellCol = 0; cellCol < GLYPH_CELL_COLS; cellCol += 1) {
      line += cellText(dots, cellRow, cellCol);
    }
    lines.push(line);
  }

  return {
    seed,
    dots,
    lines,
    hue: ((bytes[4] ?? 0) % HUE_STEPS) * (360 / HUE_STEPS),
  };
}

/** The glyph for a thing, from the id the device already shows in the clear. */
export function glyphOf(kind: GlyphKind, key: string): Glyph {
  return glyphFor(glyphSeed(kind, key));
}

/** The braille, for a terminal that cannot colour it or a log that must not. */
export function glyphText(glyph: Glyph): string {
  return glyph.lines.join("\n");
}

function hslToRgb(
  hue: number,
  saturation: number,
  lightness: number,
): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = lightness - chroma / 2;
  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const byte = (channel: number | undefined) =>
    Math.round(((channel ?? 0) + base) * 255);
  return [byte(r), byte(g), byte(b)];
}

/**
 * The braille in its hue, as 24-bit ANSI. The caller decides whether the
 * stream is a terminal that takes colour (`NO_COLOR`, a pipe): this only
 * builds the string.
 */
export function glyphAnsi(glyph: Glyph): string {
  const [r, g, b] = hslToRgb(glyph.hue, 0.55, 0.6);
  return glyph.lines
    .map((line) => `\u001b[38;2;${r};${g};${b}m${line}\u001b[0m`)
    .join("\n");
}
