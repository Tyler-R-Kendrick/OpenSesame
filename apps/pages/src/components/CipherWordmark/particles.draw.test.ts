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
    drawWordmark(
      ctx,
      layout,
      runs,
      midMs,
      1,
      4,
      [20, 20, 20],
      DRAW_CALIBRATION,
      false,
      true,
      "#2fb3a3",
      true,
    );
    drawWordmark(
      ctx,
      layout,
      runs,
      60_000,
      1,
      4,
      [230, 230, 230],
      DRAW_CALIBRATION,
      true,
      true,
      "#2fb3a3",
      true,
    );
    const smallLayout = layoutWordmark(ctx, letters, 10, 0, 4, true);
    drawWordmark(
      ctx,
      smallLayout,
      runs,
      midMs,
      1,
      4,
      [20, 20, 20],
      DRAW_CALIBRATION,
      false,
      true,
      "#2fb3a3",
      true,
    );
    expect(strokeRect).not.toHaveBeenCalled();
  });
});
