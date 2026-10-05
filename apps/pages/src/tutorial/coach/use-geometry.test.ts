/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readSafeInsets } from "./use-geometry.js";

afterEach(() => vi.restoreAllMocks());

describe("readSafeInsets", () => {
  it("reads the resolved top and bottom insets from a probe", () => {
    // SAFETY: fixture constructed in this test matches the declared contract.
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      paddingTop: "47px",
      paddingBottom: "34px",
    } as CSSStyleDeclaration);
    expect(readSafeInsets()).toEqual({ top: 47, bottom: 34 });
    expect(document.body.children).toHaveLength(0);
  });

  it("is zero where env() resolves to nothing", () => {
    // SAFETY: fixture constructed in this test matches the declared contract.
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      paddingTop: "",
      paddingBottom: "0px",
    } as CSSStyleDeclaration);
    expect(readSafeInsets()).toEqual({ top: 0, bottom: 0 });
  });
});
