import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubScreen } from "../lib/use-narrow.test-support.js";
import { KeymapSheet } from "./KeymapSheet.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pointer(coarse: boolean) {
  stubScreen({ narrow: false, coarse });
}

describe("the help sheet", () => {
  it("lists gestures, not keys, under a finger", () => {
    pointer(true);
    render(<KeymapSheet open close={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Gestures" })).toBeTruthy();
    expect(screen.getByText("Swipe a row left")).toBeTruthy();
    expect(screen.queryByText("Ctrl-d / u")).toBeNull();
  });

  it("lists keys with a mouse", () => {
    pointer(false);
    render(<KeymapSheet open close={vi.fn()} />);
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeTruthy();
    expect(screen.queryByText("Swipe a row left")).toBeNull();
  });
});
