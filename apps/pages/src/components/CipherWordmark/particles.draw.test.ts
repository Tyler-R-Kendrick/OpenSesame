/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { DISPLAY_WORD, FRAME_MS, createSlotRuns } from "./cipher.js";
import { DRAW_CALIBRATION, drawWordmark, layoutWordmark } from "./particles.js";

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
    const darkInk = [20, 20, 20] satisfies [number, number, number];
    const lightInk = [230, 230, 230] satisfies [number, number, number];
    drawWordmark({
      ctx,
      layout,
      runs,
      timeMs: midMs,
      dpr: 1,
      pad: 4,
      inkRgb: darkInk,
      calibration: DRAW_CALIBRATION,
      frozenField: false,
      showMark: true,
      accent: "#2fb3a3",
      showCursor: true,
    });
    drawWordmark({
      ctx,
      layout,
      runs,
      timeMs: 60_000,
      dpr: 1,
      pad: 4,
      inkRgb: lightInk,
      calibration: DRAW_CALIBRATION,
      frozenField: true,
      showMark: true,
      accent: "#2fb3a3",
      showCursor: true,
    });
    const smallLayout = layoutWordmark(ctx, letters, 10, 0, 4, true);
    drawWordmark({
      ctx,
      layout: smallLayout,
      runs,
      timeMs: midMs,
      dpr: 1,
      pad: 4,
      inkRgb: darkInk,
      calibration: DRAW_CALIBRATION,
      frozenField: false,
      showMark: true,
      accent: "#2fb3a3",
      showCursor: true,
    });
    expect(strokeRect).not.toHaveBeenCalled();
  });
});
