/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUIET_FEATHER, QUIET_RING_KEEP, buildQuietMask } from "./mask.js";

type Op = { kind: "fill" | "clear"; rect: number[]; op: string; style: string };

/** A 2d context that records what the mask draws. */
function recordingContext(ops: Op[]) {
  const ctx = {
    fillStyle: "",
    globalCompositeOperation: "source-over",
    save() {},
    restore() {
      ctx.globalCompositeOperation = "source-over";
    },
    fillRect(...rect: number[]) {
      ops.push({
        kind: "fill",
        rect,
        op: ctx.globalCompositeOperation,
        style: String(ctx.fillStyle),
      });
    },
    clearRect(...rect: number[]) {
      ops.push({ kind: "clear", rect, op: "", style: "" });
    },
  };
  return ctx;
}

function draw(soft: boolean): Op[] {
  const ops: Op[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    recordingContext(ops) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:,");
  buildQuietMask(800, 600, [{ x: 100, y: 200, w: 300, h: 150 }], soft);
  return ops;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildQuietMask", () => {
  it("fades the rings under the card instead of cutting them out", () => {
    const ops = draw(true);
    expect(ops.some((o) => o.kind === "clear")).toBe(false);
    const fades = ops.filter((o) => o.op === "destination-out");
    expect(fades.length).toBeGreaterThan(1);
    // The outermost step reaches the feather's edge; the innermost is the card.
    expect(fades[0]?.rect).toEqual([
      100 - QUIET_FEATHER,
      200 - QUIET_FEATHER,
      300 + QUIET_FEATHER * 2,
      150 + QUIET_FEATHER * 2,
    ]);
    // Every step covers the card, so what survives there is the keep.
    const match = /rgba\(0, 0, 0, ([\d.]+)\)/.exec(fades[0]?.style ?? "");
    const alpha = Number(match?.[1]);
    expect((1 - alpha) ** fades.length).toBeCloseTo(QUIET_RING_KEEP, 5);
  });

  it("still clears the cipher key's overlay outright", () => {
    const ops = draw(false);
    expect(ops.filter((o) => o.kind === "clear")).toHaveLength(1);
    expect(ops.some((o) => o.op === "destination-out")).toBe(false);
  });
});
