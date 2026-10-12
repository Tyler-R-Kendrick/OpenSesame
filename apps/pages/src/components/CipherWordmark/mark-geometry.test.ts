import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_ICON,
  MARK_GAP_U,
  MARK_SLAB_U,
  MARK_SLIT_U,
  MARK_UNITS,
  markRects,
} from "./mark-geometry.js";

const iconSvg = readFileSync(
  new URL("../../../public/icon.svg", import.meta.url),
  "utf8",
);

function rects(svg: string) {
  return [...svg.matchAll(/<rect ([^>]*)\/>/g)].map((m) => {
    const attrs: Record<string, string> = {};
    for (const [, k, v] of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[k] = v;
    return attrs;
  });
}

describe("the mark's geometry", () => {
  it("is a 17-unit square: slab 12, gap 2.7, slit 2.3", () => {
    expect(MARK_SLAB_U + MARK_GAP_U + MARK_SLIT_U).toBe(MARK_UNITS);
    const { slab, slit } = markRects(36);
    expect(slab.w).toBeCloseTo(25.41, 2);
    expect(slit.x).toBeCloseTo(31.13, 2);
    expect(slit.w).toBeCloseTo(4.87, 2);
    expect(slab.h).toBe(36);
  });

  it("is what public/icon.svg draws: a square tile, grey slit, no hue", () => {
    const [tile, slab, slit] = rects(iconSvg);
    expect(tile.rx).toBeUndefined();
    expect(tile.width).toBe(String(APP_ICON.tile));
    expect(tile.fill).toBe(APP_ICON.tileFill);
    const want = markRects(APP_ICON.mark, APP_ICON.inset, APP_ICON.inset);
    expect(Number(slab.x)).toBeCloseTo(want.slab.x, 2);
    expect(Number(slab.width)).toBeCloseTo(want.slab.w, 2);
    expect(Number(slab.height)).toBe(want.slab.h);
    expect(slab.fill).toBe(APP_ICON.slabFill);
    expect(Number(slit.x)).toBeCloseTo(want.slit.x, 2);
    expect(Number(slit.width)).toBeCloseTo(want.slit.w, 2);
    expect(slit.fill).toBe(APP_ICON.slitFill);
    expect(iconSvg).not.toMatch(/#2fb3a3|#0d7268/i);
  });
});
