/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import fixture from "../../../../spec/conformance/glyph-vectors.json" with {
  type: "json",
};
import {
  GLYPH_COLS,
  GLYPH_ROWS,
  type GlyphKind,
  glyphAnsi,
  glyphFor,
  glyphOf,
  glyphSeed,
  glyphText,
} from "./glyph.js";

function isKind(kind: string): kind is GlyphKind {
  return kind === "vault" || kind === "person" || kind === "org";
}

describe("glyph — the golden vectors", () => {
  it("has a vector for each kind", () => {
    expect(new Set(fixture.vectors.map((vector) => vector.kind))).toEqual(
      new Set(["vault", "person", "org"]),
    );
  });

  for (const vector of fixture.vectors) {
    it(`${vector.kind} ${vector.key} keeps its face`, () => {
      expect(isKind(vector.kind)).toBe(true);
      if (!isKind(vector.kind)) return;
      const glyph = glyphOf(vector.kind, vector.key);
      expect(glyph.lines).toEqual(vector.lines);
      expect(glyph.hue).toBe(vector.hue);
    });
  }
});

describe("glyph — shape", () => {
  const sample = Array.from({ length: 300 }, (_, i) => glyphFor(`seed-${i}`));

  it("is the same every time and on every call", () => {
    expect(glyphFor("a")).toEqual(glyphFor("a"));
    expect(glyphFor("a").lines).not.toEqual(glyphFor("b").lines);
  });

  it("is mirrored about the vertical axis", () => {
    for (const glyph of sample) {
      for (const row of glyph.dots) {
        expect(row).toHaveLength(GLYPH_COLS);
        expect([...row].reverse()).toEqual([...row]);
      }
      expect(glyph.dots).toHaveLength(GLYPH_ROWS);
    }
  });

  it("is neither a smudge nor a block", () => {
    for (const glyph of sample) {
      const lit = glyph.dots.flat().filter(Boolean).length;
      // The free half is 10–22 of 32 dots; its mirror doubles it, bar the
      // draw that ran out of tries, which is at most one in 2^16 of seeds.
      expect(lit).toBeGreaterThanOrEqual(20);
      expect(lit).toBeLessThanOrEqual(44);
    }
  });

  it("is written in braille, one string per cell row, four cells wide", () => {
    for (const glyph of sample) {
      expect(glyph.lines).toHaveLength(2);
      for (const line of glyph.lines) {
        expect([...line]).toHaveLength(4);
        for (const char of line) {
          const code = char.codePointAt(0) ?? 0;
          expect(code).toBeGreaterThanOrEqual(0x2800);
          expect(code).toBeLessThanOrEqual(0x28ff);
        }
      }
    }
  });

  it("agrees with its own dots: a lit dot is a set bit of its cell", () => {
    const glyph = glyphFor("agree");
    const first = glyph.lines[0]?.codePointAt(0) ?? 0;
    const bits = first - 0x2800;
    // (row, column) → braille bit, the dot numbering of U+2800.
    const bit = (row: number, col: number) =>
      [
        [0x01, 0x08],
        [0x02, 0x10],
        [0x04, 0x20],
        [0x40, 0x80],
      ][row]?.[col] ?? 0;
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 2; col += 1) {
        expect((bits & bit(row, col)) !== 0).toBe(glyph.dots[row]?.[col]);
      }
    }
  });

  it("tells a few thousand things apart", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      seen.add(
        `${glyphFor(`id-${i}`).lines.join("")}${glyphFor(`id-${i}`).hue}`,
      );
    }
    expect(seen.size).toBe(5000);
  });

  it("keeps a vault, a person and an organization with one id apart", () => {
    const faces = (["vault", "person", "org"] as const).map((kind) =>
      glyphText(glyphOf(kind, "same-id")),
    );
    expect(new Set(faces).size).toBe(3);
    expect(glyphSeed("vault", "x")).toBe("opensesame:glyph:v1:vault:x");
  });
});

describe("glyph — the terminal", () => {
  it("colours each line and resets it, so a pipe of lines never bleeds", () => {
    const glyph = glyphFor("ansi");
    const lines = glyphAnsi(glyph).split("\n");
    expect(lines).toHaveLength(2);
    for (const [i, line] of lines.entries()) {
      expect(line.startsWith("\u001b[38;2;")).toBe(true);
      expect(line.slice(7, line.indexOf("m"))).toMatch(/^\d+;\d+;\d+$/);
      expect(line.endsWith("\u001b[0m")).toBe(true);
      expect(line).toContain(glyph.lines[i] ?? "?");
    }
  });
});
