import { overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { OUTER_BEZEL_CLEARANCE } from "./constants.js";
import { drawOrnamentOuterScale } from "./ornament-outer.js";

it("encloses the moving cipher with smooth hairlines instead of compass labels and teeth", () => {
  const g = {
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fillText: vi.fn(),
    fill: vi.fn(),
  };
  drawOrnamentOuterScale(overlapCast(g), 831.5, 466.4, 423.9, [245, 245, 245]);
  const radii = g.arc.mock.calls.map((call) => call[2]);
  expect(radii).toEqual([423.9, 426.9, 423.9 + OUTER_BEZEL_CLEARANCE]);
  expect(g.fillText).not.toHaveBeenCalled();
  expect(g.fill).not.toHaveBeenCalled();
});
