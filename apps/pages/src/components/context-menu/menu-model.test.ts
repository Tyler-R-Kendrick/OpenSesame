import { describe, expect, it } from "vitest";
import {
  type MenuItem,
  clampToViewport,
  stepIndex,
  typeaheadIndex,
} from "./menu-model.js";

const run = () => undefined;
const items: MenuItem[] = [
  { id: "open", label: "Open", run },
  { id: "edit", label: "Edit", run, disabled: true },
  { id: "copy", label: "Copy secret", run },
  { id: "copy-user", label: "Copy username", run },
];

describe("menu motion", () => {
  it("steps over disabled entries and wraps at both ends", () => {
    expect(stepIndex(items, 0, 1)).toBe(2);
    expect(stepIndex(items, 3, 1)).toBe(0);
    expect(stepIndex(items, 0, -1)).toBe(3);
    expect(stepIndex(items, -1, 1)).toBe(0);
  });

  it("jumps to the next entry a typed letter starts", () => {
    expect(typeaheadIndex(items, 0, "c")).toBe(2);
    expect(typeaheadIndex(items, 2, "C")).toBe(3);
    expect(typeaheadIndex(items, 0, "e")).toBe(-1);
  });
});

describe("placement", () => {
  const viewport = { width: 400, height: 300 };
  it("opens where it was asked when it fits", () => {
    expect(clampToViewport(10, 20, 100, 80, viewport)).toEqual({
      left: 10,
      top: 20,
    });
  });
  it("flips toward the pointer instead of running off the edge", () => {
    expect(clampToViewport(380, 290, 100, 80, viewport)).toEqual({
      left: 280,
      top: 210,
    });
  });
  it("never leaves the viewport, however large it is", () => {
    expect(clampToViewport(5, 5, 600, 400, viewport)).toEqual({
      left: 8,
      top: 8,
    });
  });
});
