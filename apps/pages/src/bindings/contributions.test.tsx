/** @vitest-environment jsdom */
import {
  registerContributionForTest,
  resetContributionsForTest,
} from "@opensesame/app-core/lib/contributions.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useContributions } from "./contributions.js";

afterEach(() => {
  cleanup();
  resetContributionsForTest();
});

describe("useContributions", () => {
  it("keeps its array while another kind registers", () => {
    act(() => {
      registerContributionForTest("unlock-effect", {
        id: "sweep",
        run: async () => undefined,
      });
    });
    const { result } = renderHook(() => useContributions("unlock-effect"));
    const first = result.current;
    expect(first.map((effect) => effect.id)).toEqual(["sweep"]);
    // An unlock effect keyed on this array would otherwise poll again.
    act(() => {
      registerContributionForTest("command-path", { path: "/x", label: "X" });
    });
    expect(result.current).toBe(first);
    act(() => {
      registerContributionForTest("unlock-effect", {
        id: "seal",
        run: async () => undefined,
      });
    });
    expect(result.current).not.toBe(first);
    expect(result.current).toHaveLength(2);
  });
});
