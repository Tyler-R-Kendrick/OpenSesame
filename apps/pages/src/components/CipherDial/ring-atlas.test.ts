/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RingSpec } from "./layout-types.js";
import { ensureRingAtlas } from "./ring-atlas.js";

/** Minimal 2d context: jsdom's has no `scale`. */
function stubContext(): CanvasRenderingContext2D {
  const textAlign: CanvasTextAlign = "center";
  const textBaseline: CanvasTextBaseline = "middle";
  const ctx: Partial<CanvasRenderingContext2D> = {
    scale: vi.fn(),
    font: "",
    textAlign,
    textBaseline,
    fillStyle: "",
    fillText: vi.fn(),
  };
  // SAFETY: test double implements only the methods ensureRingAtlas calls.
  return ctx as CanvasRenderingContext2D;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
    stubContext(),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubRing(): RingSpec {
  return {
    i: 0,
    r: 100,
    N: 4,
    pa: 1,
    fs: 12,
    cipher: ["A", "B"],
    plain: ["A", "B"],
    letter: "A",
    isTick: false,
    jt: 0,
    bx0: 0,
    by0: 0,
    bx1: 10,
    by1: 10,
    k: 0,
    from: 0,
    to: 0,
    t0: -1,
    dur: 140,
    dir: 1,
    period: 700,
    next: 0,
    rand: () => 0.5,
    alpha: 0.15,
    dirty: true,
  };
}

describe("ensureRingAtlas", () => {
  it("rebakes when ink changes after a theme switch", () => {
    const q = stubRing();
    ensureRingAtlas(q, [15, 15, 15], 1);
    const first = q.atlas;
    expect(q.atlasInk).toBe("15,15,15");
    ensureRingAtlas(q, [15, 15, 15], 1);
    expect(q.atlas).toBe(first);
    ensureRingAtlas(q, [240, 240, 240], 1);
    expect(q.atlas).not.toBe(first);
    expect(q.atlasInk).toBe("240,240,240");
  });
});
