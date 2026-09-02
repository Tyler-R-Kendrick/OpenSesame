/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { pageSteps, stepIndex, viewportIndex } from "./tree-motion.js";

describe("stepIndex", () => {
  it("clamps to the ends and treats an empty list as nowhere", () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
    expect(stepIndex(2, 1, 4)).toBe(3);
    expect(stepIndex(0, -1, 4)).toBe(0);
    expect(stepIndex(-1, 1, 4)).toBe(1);
    expect(stepIndex(2, Number.POSITIVE_INFINITY, 4)).toBe(3);
    expect(stepIndex(2, Number.NEGATIVE_INFINITY, 4)).toBe(0);
  });
});

describe("pageSteps", () => {
  it("falls back when the scroller has no layout", () => {
    expect(pageSteps(null, true)).toBe(5);
    expect(pageSteps(null, false)).toBe(10);
  });

  it("uses half or all but one of the visible rows", () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 280 });
    const row = document.createElement("div");
    row.setAttribute("role", "treeitem");
    Object.defineProperty(row, "offsetHeight", { value: 28 });
    scroller.append(row);
    expect(pageSteps(scroller, true)).toBe(5);
    expect(pageSteps(scroller, false)).toBe(9);
  });
});

describe("viewportIndex", () => {
  it("picks high, mid and low of the whole list without a viewport", () => {
    const rows = [0, 1, 2, 3, 4].map(() => document.createElement("div"));
    expect(viewportIndex(null, rows, "high")).toBe(0);
    expect(viewportIndex(null, rows, "mid")).toBe(2);
    expect(viewportIndex(null, rows, "low")).toBe(4);
  });

  it("picks fully visible rows when the scroller has a window", () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 40 });
    Object.defineProperty(scroller, "scrollTop", { value: 20 });
    const rows = [0, 1, 2, 3].map((_, i) => {
      const row = document.createElement("div");
      Object.defineProperty(row, "offsetTop", { value: i * 20 });
      Object.defineProperty(row, "offsetHeight", { value: 20 });
      return row;
    });
    // Window is [20, 60]: rows 1 and 2 overlap it.
    expect(viewportIndex(scroller, rows, "high")).toBe(1);
    expect(viewportIndex(scroller, rows, "low")).toBe(2);
    expect(viewportIndex(scroller, rows, "mid")).toBe(1);
  });

  it("returns nowhere for an empty list", () => {
    expect(viewportIndex(null, [], "high")).toBe(-1);
  });
});
