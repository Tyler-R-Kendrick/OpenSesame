import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { MAX_DIFF_RATIO, comparePngBuffers, isUpdateMode } from "./compare.js";

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

function solidRgba(red: number, green: number, blue: number): Buffer {
  const image = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = red;
    image.data[i + 1] = green;
    image.data[i + 2] = blue;
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

describe("PACT — visual-contract compare", () => {
  it("property: identical buffers match inside the budget", () => {
    const png = solidPng(8, 8, 32);
    const result = comparePngBuffers(png, png);
    expect(result.matched).toBe(true);
    expect(result.diffPixelCount).toBe(0);
    expect(result.diffRatio).toBe(0);
  });

  it("retains v7 detection when v8 considers a color shift below threshold", () => {
    const result = comparePngBuffers(
      solidRgba(118, 30, 44),
      solidRgba(112, 0, 6),
    );
    expect(result.matched).toBe(false);
    expect(result.diffPixelCount).toBe(64);
  });

  it("detects a dark color shift that v8 treats as significant", () => {
    const result = comparePngBuffers(solidRgba(0, 0, 0), solidRgba(25, 25, 25));
    expect(result.matched).toBe(false);
    expect(result.diffPixelCount).toBe(64);
  });

  it("allows a small color shift below both thresholds", () => {
    const result = comparePngBuffers(
      solidRgba(128, 128, 128),
      solidRgba(135, 135, 135),
    );
    expect(result.matched).toBe(true);
    expect(result.diffPixelCount).toBe(0);
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
    Reflect.deleteProperty(process.env, "VISUAL_UPDATE");
    expect(isUpdateMode()).toBe(false);
    process.env.VISUAL_UPDATE = "1";
    expect(isUpdateMode()).toBe(true);
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "VISUAL_UPDATE");
    } else process.env.VISUAL_UPDATE = previous;
  });
});
