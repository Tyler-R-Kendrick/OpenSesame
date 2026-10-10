/** @vitest-environment jsdom */
/**
 * The wordmark's resize observer (`use-cipher-lifecycle.ts`): sizing the
 * canvas sizes the root it watches, so the size changes on the next frame,
 * never inside the observer's own callback — there it is a ResizeObserver
 * loop, which WebKit raises as a page error on every title screen.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCipherLifecycle } from "./use-cipher-lifecycle.js";

let observed: (() => void) | null = null;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;

class FakeResizeObserver {
  constructor(callback: () => void) {
    observed = callback;
  }
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  observed = null;
  frames = new Map();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const resize = vi.fn();
  const paint = vi.fn();
  const view = renderHook(() =>
    useCipherLifecycle({
      rootRef: { current: document.createElement("span") },
      canvasRef: { current: document.createElement("canvas") },
      visibleRef: { current: true },
      rafRef: { current: 0 },
      resize,
      paint,
      scheduleFrame: vi.fn(),
    }),
  );
  return { resize, paint, view };
}

function runFrames() {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(0);
}

describe("the wordmark's resize observer", () => {
  it("sizes the canvas on the next frame, never inside its own callback", () => {
    const { resize, paint } = mount();
    observed?.();
    expect(resize).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
    runFrames();
    expect(resize).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it("takes several notices in one frame as one resize", () => {
    const { resize } = mount();
    observed?.();
    observed?.();
    observed?.();
    runFrames();
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("leaves no frame behind once it is gone", () => {
    const { resize, view } = mount();
    observed?.();
    view.unmount();
    runFrames();
    expect(resize).not.toHaveBeenCalled();
  });
});
