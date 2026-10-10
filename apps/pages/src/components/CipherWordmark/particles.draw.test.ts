/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { CIPHER, DISPLAY_WORD, FRAME_MS, createSlotRuns } from "./cipher.js";
import { DRAW_CALIBRATION, drawWordmark, layoutWordmark } from "./particles.js";
import { stubCanvas2d } from "./test-canvas.js";

type Ink = [number, number, number];

function drawAt(
  ctx: CanvasRenderingContext2D,
  em: number,
  inkRgb: Ink,
  frozenField: boolean,
  timeMs: number,
) {
  const letters = DISPLAY_WORD.split("");
  const layout = layoutWordmark(ctx, letters, em, 0, 4, true);
  const slots = createSlotRuns(letters, Math.random);
  const runs = [{ t0: 0, slots }];
  drawWordmark({
    ctx,
    layout,
    runs,
    timeMs,
    dpr: 1,
    pad: 4,
    inkRgb,
    calibration: DRAW_CALIBRATION,
    frozenField,
    showMark: true,
    slit: "#8f8f8f",
    showCursor: true,
  });
  return { layout, slots };
}

stubCanvas2d();

describe("drawWordmark", () => {
  it("never uses strokeRect for the brightness cursor, in any tier", () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context required");
    const strokeRect = vi.fn();
    Object.assign(ctx, { strokeRect });
    const darkInk: Ink = [20, 20, 20];
    const lightInk: Ink = [230, 230, 230];
    const { slots } = drawAt(ctx, 72, darkInk, false, 0);
    const midMs =
      slots[0].delay * FRAME_MS + Math.floor(slots[0].duration / 2) * FRAME_MS;
    drawAt(ctx, 72, darkInk, false, midMs);
    drawAt(ctx, 72, lightInk, true, 60_000);
    drawAt(ctx, 28, darkInk, false, midMs);
    drawAt(ctx, 12, darkInk, false, midMs);
    expect(strokeRect).not.toHaveBeenCalled();
  });

  it("paints the mark's slit in the slit colour, never the ink", () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context required");
    const fills: string[] = [];
    const fillRect = vi.fn(() => {
      fills.push(String(ctx.fillStyle));
    });
    Object.assign(ctx, { fillRect });
    drawAt(ctx, 28, [23, 23, 23], true, 60_000);
    expect(fills.at(-1)).toBe("#8f8f8f");
    expect(fills.at(-2)).toBe("rgb(23,23,23)");
  });

  it("gives every slot a mask for every cipher glyph, so no slot draws blank mid-decode", () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context required");
    const { layout } = drawAt(ctx, 72, [23, 23, 23], false, 0);
    for (const q of layout.slots) {
      if (q.space) continue;
      for (const ch of CIPHER) expect(q.masks.has(ch)).toBe(true);
    }
  });
});
