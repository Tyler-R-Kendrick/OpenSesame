import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  MAX_DIFF_RATIO,
  comparePngBuffers,
  isUpdateMode,
} from "./compare.js";

function solidPng(width: number, height: number, fill: number): Buffer {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = fill;
    img.data[i + 1] = fill;
    img.data[i + 2] = fill;
    img.data[i + 3] = 255;
  }
  return PNG.sync.write(img);
}

describe("PACT — visual-contract compare", () => {
  it("property: identical buffers match inside the budget", () => {
    const png = solidPng(8, 8, 32);
    const result = comparePngBuffers(png, png);
    expect(result.matched).toBe(true);
    expect(result.diffPixelCount).toBe(0);
    expect(result.diffRatio).toBe(0);
  });

  it("adversarial: dimension mismatch fails closed without claiming a pixel ratio", () => {
    const a = solidPng(8, 8, 32);
    const b = solidPng(4, 4, 32);
    const result = comparePngBuffers(a, b);
    expect(result.matched).toBe(false);
    expect(result.diffPixelCount).toBe(-1);
    expect(result.diffRatio).toBe(1);
  });

  it("chaos: a fully inverted capture exceeds MAX_DIFF_RATIO", () => {
    const a = solidPng(8, 8, 0);
    const b = solidPng(8, 8, 255);
    const result = comparePngBuffers(a, b);
    expect(result.matched).toBe(false);
    expect(result.diffRatio).toBeGreaterThan(MAX_DIFF_RATIO);
  });

  it("contract: rebaseline is opt-in via VISUAL_UPDATE=1", () => {
    const previous = process.env.VISUAL_UPDATE;
    delete process.env.VISUAL_UPDATE;
    expect(isUpdateMode()).toBe(false);
    process.env.VISUAL_UPDATE = "1";
    expect(isUpdateMode()).toBe(true);
    if (previous === undefined) delete process.env.VISUAL_UPDATE;
    else process.env.VISUAL_UPDATE = previous;
  });
});
