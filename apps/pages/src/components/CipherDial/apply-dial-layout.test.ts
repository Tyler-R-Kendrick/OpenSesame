/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import { measureAndPaintDial } from "./apply-dial-layout.js";

function recordingContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    scale: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
  };
}

const contexts = new WeakMap<
  HTMLCanvasElement,
  ReturnType<typeof recordingContext>
>();
function contextFor(canvas: HTMLCanvasElement) {
  let context = contexts.get(canvas);
  if (!context) {
    context = recordingContext();
    contexts.set(canvas, context);
  }
  return context;
}

afterEach(() => vi.restoreAllMocks());

function fixture() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      return overlapCast(contextFor(this));
    },
  );
  const pane = document.createElement("div");
  const card = document.createElement("div");
  const notes = document.createElement("aside");
  const ring = document.createElement("canvas");
  const overlay = document.createElement("canvas");
  const paneBounds = vi
    .spyOn(pane, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 1663, 946));
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue(
    new DOMRect(293, 284, 352, 380),
  );
  const notesBounds = vi
    .spyOn(notes, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(831.5, 0, 831.5, 946));
  const refs = {
    pane,
    card,
    notes,
    fixed: null,
    overlay,
    ringLayer: null,
    ringCanvasRefs: new Map([[0, ring]]),
  };
  return { refs, paneBounds, notesBounds, ring, overlay };
}

it("repaints static glyphs immediately after a resize clears the canvases", () => {
  const { refs, paneBounds, notesBounds, ring } = fixture();
  const first = measureAndPaintDial(refs);
  expect(contextFor(ring).drawImage).toHaveBeenCalled();
  contextFor(ring).drawImage.mockClear();
  paneBounds.mockReturnValue(new DOMRect(0, 0, 1366, 768));
  notesBounds.mockReturnValue(new DOMRect(683, 0, 683, 768));
  const resized = measureAndPaintDial(refs, first?.layout.rings);
  expect(resized?.layout.w).toBe(1366);
  expect(contextFor(ring).drawImage).toHaveBeenCalled();
});

it("retains the current alignment illumination when relayout repaints", () => {
  const { refs, overlay } = fixture();
  measureAndPaintDial(refs, undefined, 1);
  expect(contextFor(overlay).fillText).toHaveBeenCalled();
});
