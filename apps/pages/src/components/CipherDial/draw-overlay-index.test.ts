import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { drawOverlay } from "./draw-overlay-index.js";
import { computeDialLayout } from "./layout.js";

function context() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
  };
}

const layout = () =>
  computeDialLayout({
    w: 1663,
    h: 946,
    card: { x: 293, y: 284, w: 352, h: 380 },
    notes: { x: 831.5, y: 0, w: 831.5, h: 946 },
    narrow: false,
    nowMs: 0,
  });

describe("cipher readout", () => {
  it("leaves the idle form free of foreground index lines and letters", () => {
    const g = context();
    const dial = layout();
    drawOverlay(overlapCast(g), dial, dial.rings, 0, [245, 245, 245], 1);
    expect(g.clearRect).toHaveBeenCalledWith(0, 0, 1663, 946);
    expect(g.stroke).not.toHaveBeenCalled();
    expect(g.fillText).not.toHaveBeenCalled();
  });

  it("still lights the decoded readout during successful alignment", () => {
    const g = context();
    const dial = layout();
    drawOverlay(overlapCast(g), dial, dial.rings, 1, [245, 245, 245], 1);
    expect(g.stroke).toHaveBeenCalled();
    expect(g.fillText).toHaveBeenCalled();
  });
});
