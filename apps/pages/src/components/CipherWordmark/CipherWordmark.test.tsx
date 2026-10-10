/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CipherWordmark } from "./CipherWordmark.js";
import {
  CIPHER,
  FRAME_MS,
  MAX_STEPS,
  MIN_STEPS,
  cipherReel,
  createSlotRuns,
  slotState,
} from "./cipher.js";
import { DRAW_CALIBRATION, cursorBoostFor } from "./particles.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("cipherReel", () => {
  it("is uppercase hex then locks on the target glyph", () => {
    const reel = cipherReel(0, "0", MAX_STEPS);
    expect(reel).toHaveLength(MAX_STEPS + 1);
    expect(reel.endsWith("0")).toBe(true);
    expect(
      [...reel.slice(0, -1)].every((glyph) => CIPHER.includes(glyph)),
    ).toBe(true);
  });

  it("is deterministic per slot", () => {
    expect(cipherReel(3, "N", 8)).toBe(cipherReel(3, "N", 8));
    expect(cipherReel(0, "0", 8)).not.toBe(cipherReel(1, "P", 8));
  });
});

describe("createSlotRuns", () => {
  it("staggers non-space slots in sequence", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.999);
    const runs = createSlotRuns("0P".split(""), Math.random);
    expect(runs[0].delay).toBe(0);
    expect(runs[0].duration).toBe(MIN_STEPS);
    expect(runs[1].delay).toBe(MIN_STEPS);
    expect(runs[1].duration).toBe(MAX_STEPS);
    expect(runs[0].delay * FRAME_MS).toBeLessThan(runs[1].delay * FRAME_MS);
  });
});

describe("pruneRuns", () => {
  it("keeps the newest completed run for settled redraws", async () => {
    const { pruneRuns } = await import("./cipher.js");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const slots = createSlotRuns("0P".split(""), Math.random);
    const runs = [{ t0: 0, slots }];
    const after = (slots[1].steps + 5) * FRAME_MS;
    const kept = pruneRuns(runs, after);
    expect(kept).toHaveLength(1);
    expect(kept[0].slots[0].letter).toBe("0");
    expect(kept[0].slots[1].letter).toBe("P");
  });
});

describe("brightness cursor (not a border)", () => {
  it("marks exactly one active cell while decrypting, then none when settled", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const slots = createSlotRuns("0P".split(""), Math.random);
    const runs = [{ t0: 0, slots }];
    const midFirst = slots[0].delay * FRAME_MS + FRAME_MS;
    const midSecond =
      slots[1].delay * FRAME_MS + Math.floor(slots[1].duration / 2) * FRAME_MS;
    const after = (slots[1].steps + 2) * FRAME_MS;
    expect(slotState(runs, 0, midFirst).cursor).toBe(true);
    expect(slotState(runs, 1, midFirst).cursor).toBe(false);
    expect(slotState(runs, 0, midSecond).cursor).toBe(false);
    expect(slotState(runs, 1, midSecond).cursor).toBe(true);
    expect(slotState(runs, 0, after).cursor).toBe(false);
    expect(slotState(runs, 1, after).cursor).toBe(false);
  });

  it("uses a stronger plate boost on light ink (dark theme)", () => {
    expect(cursorBoostFor([20, 20, 20], DRAW_CALIBRATION, true)).toBe(
      DRAW_CALIBRATION.cursorBoostLight,
    );
    expect(cursorBoostFor([230, 230, 230], DRAW_CALIBRATION, true)).toBe(
      DRAW_CALIBRATION.cursorBoostDark,
    );
    expect(cursorBoostFor([20, 20, 20], DRAW_CALIBRATION, false)).toBe(1);
  });
});

describe("CipherWordmark", () => {
  it("renders a canvas and publishes slot timings", () => {
    const { container } = render(<CipherWordmark static />);
    const canvas = container.querySelector("canvas.cipher-wordmark__canvas");
    expect(canvas).toBeTruthy();
    const root = container.querySelector(".cipher-wordmark");
    expect(root?.getAttribute("data-cipher-timings")).toBeTruthy();
  });

  it("exposes replay on the ref", () => {
    const ref = createRef<import("./CipherWordmark.js").CipherWordmarkHandle>();
    render(<CipherWordmark ref={ref} />);
    expect(ref.current?.replay).toBeTypeOf("function");
    ref.current?.replay();
  });
});
