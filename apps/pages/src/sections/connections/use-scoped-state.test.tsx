/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScopedState } from "./use-scoped-state.js";

describe("useScopedState", () => {
  it("shows a value only on the scope that set it", () => {
    const { result, rerender } = renderHook(
      ({ scope }) => useScopedState<string>(scope),
      { initialProps: { scope: "github" } },
    );
    act(() => result.current[1]("from github"));
    expect(result.current[0]).toBe("from github");

    rerender({ scope: "better-auth" });
    expect(result.current[0]).toBeNull();
  });

  it("does not bring the value back when the first scope is opened again", () => {
    const { result, rerender } = renderHook(
      ({ scope }) => useScopedState<string>(scope),
      { initialProps: { scope: "github" } },
    );
    act(() => result.current[1]("from github"));
    rerender({ scope: "better-auth" });
    rerender({ scope: "github" });
    expect(result.current[0]).toBeNull();
  });

  it("is cleared by setting null", () => {
    const { result } = renderHook(() => useScopedState<string>("github"));
    act(() => result.current[1]("x"));
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
  });
});
