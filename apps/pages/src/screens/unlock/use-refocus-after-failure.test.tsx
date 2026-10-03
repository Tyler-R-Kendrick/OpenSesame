/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRefocusAfterFailure } from "./use-refocus-after-failure.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function field(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.append(input);
  return input;
}

type Props = Readonly<{ busy: boolean; gated: boolean }>;

function setup(props: Props) {
  return renderHook(({ busy, gated }) => useRefocusAfterFailure(busy, gated), {
    initialProps: props,
  });
}

describe("useRefocusAfterFailure", () => {
  it("grants the caret on the render that clears busy, not before", () => {
    const input = field();
    input.disabled = true;
    const { result, rerender } = setup({ busy: true, gated: false });
    result.current.current = { current: input };
    // Still in flight: nothing is focused, and the request stays pending.
    rerender({ busy: true, gated: false });
    expect(document.activeElement).not.toBe(input);
    expect(result.current.current).not.toBeNull();

    input.disabled = false;
    rerender({ busy: false, gated: false });
    expect(document.activeElement).toBe(input);
    expect(result.current.current).toBeNull();
  });

  it("waits out a lockout the miss started, then lands", () => {
    const input = field();
    const { result, rerender } = setup({ busy: true, gated: false });
    result.current.current = { current: input };
    rerender({ busy: false, gated: true });
    expect(document.activeElement).not.toBe(input);

    rerender({ busy: false, gated: false });
    expect(document.activeElement).toBe(input);
  });

  it("does nothing when no failure asked for focus", () => {
    const input = field();
    const { rerender } = setup({ busy: true, gated: false });
    rerender({ busy: false, gated: false });
    expect(document.activeElement).not.toBe(input);
  });
});
