/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CipherWordmark } from "./CipherWordmark.js";
import {
  CIPHER,
  DISPLAY_WORD,
  FRAME_MS,
  MAX_STEPS,
  MIN_STEPS,
  cipherReel,
  createSlotRuns,
  cursorSlot,
  pruneRuns,
  slotState,
} from "./cipher.js";
import {
  DRAW_CALIBRATION,
  SOLID_MAX_EM,
  TYPE_MAX_EM,
  cursorBoostFor,
  tierOf,
} from "./particles.js";
import { stubCanvas2d } from "./test-canvas.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

stubCanvas2d();

describe("the name", () => {
  it("is OPEN SESAME with the letter O, uppercase, one space", () => {
    expect(DISPLAY_WORD).toBe("OPEN SESAME");
    expect(DISPLAY_WORD).toHaveLength(11);
  });
});

describe("cipherReel", () => {
  it("is uppercase hex then locks on the target glyph", () => {
    const reel = cipherReel(0, "O", MAX_STEPS);
    expect(reel).toHaveLength(MAX_STEPS + 1);
    expect(reel.endsWith("O")).toBe(true);
    expect(
      [...reel.slice(0, -1)].every((glyph) => CIPHER.includes(glyph)),
    ).toBe(true);
  });

  it("is deterministic per slot", () => {
    expect(cipherReel(3, "N", 8)).toBe(cipherReel(3, "N", 8));
    expect(cipherReel(0, "O", 8)).not.toBe(cipherReel(1, "P", 8));
  });
});

describe("createSlotRuns", () => {
  it("staggers non-space slots in sequence and skips the space", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.999);
    const runs = createSlotRuns("N S".split(""), Math.random);
    expect(runs[0].delay).toBe(0);
    expect(runs[0].duration).toBe(MIN_STEPS);
    expect(runs[1].duration).toBe(0);
    expect(runs[2].delay).toBe(MIN_STEPS);
    expect(runs[2].duration).toBe(MAX_STEPS);
  });
});

describe("pruneRuns", () => {
  it("keeps the newest completed run for settled redraws", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const slots = createSlotRuns("OP".split(""), Math.random);
    const runs = [{ t0: 0, slots }];
    const after = (slots[1].steps + 5) * FRAME_MS;
    const kept = pruneRuns(runs, after);
    expect(kept).toHaveLength(1);
    expect(kept[0].slots[0].letter).toBe("O");
    expect(kept[0].slots[1].letter).toBe("P");
  });
});

describe("brightness cursor (not a border)", () => {
  it("marks exactly one active cell while decrypting, then none when settled", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const slots = createSlotRuns("OP".split(""), Math.random);
    const runs = [{ t0: 0, slots }];
    const midFirst = slots[0].delay * FRAME_MS + FRAME_MS;
    const midSecond =
      slots[1].delay * FRAME_MS + Math.floor(slots[1].duration / 2) * FRAME_MS;
    const after = (slots[1].steps + 2) * FRAME_MS;
    expect(slotState(runs, 0, midFirst).cursor).toBe(true);
    expect(slotState(runs, 1, midFirst).cursor).toBe(false);
    expect(cursorSlot(runs, midFirst)).toBe(0);
    expect(slotState(runs, 0, midSecond).cursor).toBe(false);
    expect(slotState(runs, 1, midSecond).cursor).toBe(true);
    expect(cursorSlot(runs, midSecond)).toBe(1);
    expect(slotState(runs, 0, after).cursor).toBe(false);
    expect(slotState(runs, 1, after).cursor).toBe(false);
    expect(cursorSlot(runs, after)).toBe(-1);
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

describe("size tiers", () => {
  it("draws letters under 16px, solid plates to 48px, the field from 48px", () => {
    expect(TYPE_MAX_EM).toBe(16);
    expect(SOLID_MAX_EM).toBe(48);
    expect(tierOf(12)).toBe("type");
    expect(tierOf(15.9)).toBe("type");
    expect(tierOf(16)).toBe("solid");
    expect(tierOf(28)).toBe("solid");
    expect(tierOf(47.9)).toBe("solid");
    expect(tierOf(48)).toBe("field");
    expect(tierOf(90)).toBe("field");
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
