import { describe, expect, it } from "vitest";
import { LIGHT_INK_ALPHA_SCALE, inkAlpha } from "./ink.js";

describe("inkAlpha", () => {
  it("leaves dark ink alphas unchanged (light theme)", () => {
    expect(inkAlpha([15, 15, 15], 0.15)).toBe("rgba(15,15,15,0.15)");
  });

  it("lifts light ink alphas for dark theme readability", () => {
    expect(inkAlpha([240, 240, 240], 0.15)).toBe(
      `rgba(240,240,240,${Math.min(1, 0.15 * LIGHT_INK_ALPHA_SCALE)})`,
    );
  });

  it("clamps scaled light ink to 1", () => {
    expect(inkAlpha([240, 240, 240], 0.5)).toBe("rgba(240,240,240,1)");
  });
});
