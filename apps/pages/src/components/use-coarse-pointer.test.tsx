/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COARSE_POINTER_QUERY, isTouchPointer } from "../lib/gestures.js";
import { FakeMediaQueryList } from "../lib/use-narrow.test-fake.js";
import { useCoarsePointer } from "./use-coarse-pointer.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A MediaQueryList with only the members a given browser has. */
function list(matches: boolean, members: Partial<MediaQueryList>) {
  return { matches, media: COARSE_POINTER_QUERY, ...members };
}

function stub(mql: Partial<MediaQueryList> | null) {
  vi.stubGlobal("matchMedia", () => mql);
}

describe("useCoarsePointer", () => {
  it("reads the one query isTouchPointer reads", () => {
    const asked: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      asked.push(query);
      return list(true, {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      });
    });
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(true);
    expect(isTouchPointer()).toBe(true);
    expect(new Set(asked)).toEqual(new Set([COARSE_POINTER_QUERY]));
  });

  it("follows a pointer that changes while the page is open", () => {
    const mql = new FakeMediaQueryList(COARSE_POINTER_QUERY, false);
    vi.stubGlobal("matchMedia", () => mql);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);
    act(() => mql.set(true));
    expect(result.current).toBe(true);
  });

  it("does not throw on a MediaQueryList that has only addListener", () => {
    // Safari before 14.
    let notify: () => void = () => undefined;
    let coarse = false;
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return coarse;
      },
      addListener: (fn: () => void) => {
        notify = fn;
      },
      removeListener: () => undefined,
    }));
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);
    coarse = true;
    act(() => notify());
    expect(result.current).toBe(true);
  });

  it("does not throw on a bare object or no list at all", () => {
    stub({ matches: true });
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(true);
    cleanup();
    stub(null);
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(false);
  });
});
