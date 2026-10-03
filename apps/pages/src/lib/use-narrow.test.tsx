/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFinePointer, useMediaQuery, useNarrow } from "./use-narrow.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function media(matching: readonly string[]) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: matching.some((part) => query.includes(part)),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

describe("media hooks", () => {
  it("answers what the browser says", () => {
    media(["max-width: 900px"]);
    expect(renderHook(() => useNarrow()).result.current).toBe(true);
    expect(renderHook(() => useFinePointer()).result.current).toBe(false);
    media(["any-pointer: fine"]);
    expect(renderHook(() => useNarrow()).result.current).toBe(false);
    expect(renderHook(() => useFinePointer()).result.current).toBe(true);
  });

  it("answers the caller's default where nothing can be measured", () => {
    expect(renderHook(() => useNarrow()).result.current).toBe(false);
    expect(renderHook(() => useFinePointer()).result.current).toBe(true);
    expect(renderHook(() => useMediaQuery("(x)", true)).result.current).toBe(
      true,
    );
  });
});
