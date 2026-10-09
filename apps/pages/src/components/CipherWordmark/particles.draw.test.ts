/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { DISPLAY_WORD, FRAME_MS, createSlotRuns } from "./cipher.js";
import { DRAW_CALIBRATION, drawWordmark, layoutWordmark } from "./particles.js";

function paintAt(
  ctx: CanvasRenderingContext2D,
  layout: ReturnType<typeof layoutWordmark>,
  runs: { t0: number; slots: ReturnType<typeof createSlotRuns> }[],
  timeMs: number,
  inkRgb: [number, number, number],
  frozenField: boolean,
): void {
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
    accent: "#2fb3a3",
    showCursor: true,
  });
}

describe("drawWordmark", () => {
  it("never uses strokeRect for the brightness cursor", () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context required");
    const strokeRect = vi.fn();
    Object.assign(ctx, { strokeRect });
    const letters = DISPLAY_WORD.split("");
    const layout = layoutWordmark(ctx, letters, 24, 0, 4, true);
    const slots = createSlotRuns(letters, Math.random);
    const runs = [{ t0: 0, slots }];
    const midMs =
      slots[0].delay * FRAME_MS + Math.floor(slots[0].duration / 2) * FRAME_MS;
    paintAt(ctx, layout, runs, midMs, [20, 20, 20], false);
    paintAt(ctx, layout, runs, 60_000, [230, 230, 230], true);
    const smallLayout = layoutWordmark(ctx, letters, 10, 0, 4, true);
    paintAt(ctx, smallLayout, runs, midMs, [20, 20, 20], false);
    expect(strokeRect).not.toHaveBeenCalled();
  });
});
