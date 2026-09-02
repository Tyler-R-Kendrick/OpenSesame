/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { pageSteps, stepIndex, viewportIndex } from "./tree-motion.js";

function rowAt(top: number, height = 20): HTMLDivElement {
  const row = document.createElement("div");
  Object.defineProperty(row, "offsetTop", { value: top });
  Object.defineProperty(row, "offsetHeight", { value: height });
  return row;
}

function scroller(height: number, scrollTop = 0): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { value: height });
  Object.defineProperty(el, "scrollTop", { value: scrollTop });
  return el;
}

describe("stepIndex", () => {
  it("returns nowhere for an empty or negative-length list", () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
    expect(stepIndex(0, 1, -3)).toBe(-1);
  });

  it("jumps to the ends on infinities", () => {
    expect(stepIndex(2, Number.POSITIVE_INFINITY, 4)).toBe(3);
    expect(stepIndex(2, Number.NEGATIVE_INFINITY, 4)).toBe(0);
    expect(stepIndex(0, Number.POSITIVE_INFINITY, 1)).toBe(0);
  });

  it("a one-row list stays on that row, including a negative delta", () => {
    expect(stepIndex(0, 0, 1)).toBe(0);
    expect(stepIndex(0, -1, 1)).toBe(0);
    expect(stepIndex(0, 4, 1)).toBe(0);
  });

  it("an empty list is nowhere even when the delta would clamp to zero", () => {
    expect(stepIndex(0, -1, 0)).toBe(-1);
    expect(stepIndex(0, Number.NEGATIVE_INFINITY, 0)).toBe(-1);
  });

  it("treats a missing cursor as the first row before applying delta", () => {
    expect(stepIndex(-1, 1, 4)).toBe(1);
    expect(stepIndex(-1, 0, 4)).toBe(0);
    expect(stepIndex(-5, 2, 4)).toBe(2);
  });

  it("clamps past both ends", () => {
    expect(stepIndex(0, -1, 4)).toBe(0);
    expect(stepIndex(0, -10, 4)).toBe(0);
    expect(stepIndex(3, 1, 4)).toBe(3);
    expect(stepIndex(2, 8, 4)).toBe(3);
  });

  it("steps inside the list", () => {
    expect(stepIndex(1, 1, 4)).toBe(2);
    expect(stepIndex(2, -1, 4)).toBe(1);
    expect(stepIndex(0, 0, 4)).toBe(0);
  });
});

describe("pageSteps", () => {
  it("uses the half/full fallbacks when there is no scroller", () => {
    expect(pageSteps(null, true)).toBe(5);
    expect(pageSteps(null, false)).toBe(10);
    expect(pageSteps(null, true, 3)).toBe(3);
    expect(pageSteps(null, false, 7)).toBe(7);
  });

  it("falls back when the scroller has no height", () => {
    expect(pageSteps(scroller(0), true)).toBe(5);
    expect(pageSteps(scroller(0), false)).toBe(10);
  });

  it("falls back on a zero-height scroller even when a row is there to measure", () => {
    const el = scroller(0);
    const row = document.createElement("div");
    row.setAttribute("role", "treeitem");
    Object.defineProperty(row, "offsetHeight", { value: 28 });
    el.append(row);
    expect(pageSteps(el, true)).toBe(5);
    expect(pageSteps(el, false)).toBe(10);
  });

  it("a 1px scroller with a taller row is a one-row page, not the fallback", () => {
    const el = scroller(1);
    const row = document.createElement("div");
    row.setAttribute("role", "treeitem");
    Object.defineProperty(row, "offsetHeight", { value: 28 });
    el.append(row);
    expect(pageSteps(el, true)).toBe(1);
    expect(pageSteps(el, false)).toBe(1);
  });

  it("measures a 1px row against a tall scroller instead of falling back", () => {
    const el = scroller(20);
    const row = document.createElement("div");
    row.setAttribute("role", "treeitem");
    Object.defineProperty(row, "offsetHeight", { value: 1 });
    el.append(row);
    expect(pageSteps(el, true)).toBe(10);
    expect(pageSteps(el, false)).toBe(19);
  });

  it("falls back when no row is in the scroller to measure", () => {
    expect(pageSteps(scroller(280), false)).toBe(10);
  });

  it("measures a role=treeitem row", () => {
    const el = scroller(280);
    const row = document.createElement("div");
    row.setAttribute("role", "treeitem");
    Object.defineProperty(row, "offsetHeight", { value: 28 });
    el.append(row);
    expect(pageSteps(el, true)).toBe(5);
    expect(pageSteps(el, false)).toBe(9);
  });

  it("measures a railtree row when there is no treeitem", () => {
    const el = scroller(280);
    const row = document.createElement("div");
    row.className = "railtree__row";
    Object.defineProperty(row, "offsetHeight", { value: 28 });
    el.append(row);
    expect(pageSteps(el, true)).toBe(5);
    expect(pageSteps(el, false)).toBe(9);
  });

  it("never returns a zero-sized page when only one row fits", () => {
    const el = scroller(28);
    const row = document.createElement("div");
    row.setAttribute("role", "treeitem");
    Object.defineProperty(row, "offsetHeight", { value: 28 });
    el.append(row);
    expect(pageSteps(el, true)).toBe(1);
    expect(pageSteps(el, false)).toBe(1);
  });

  it("uses two visible rows as a one-row half page and a one-row full page", () => {
    const el = scroller(56);
    const row = document.createElement("div");
    row.setAttribute("role", "treeitem");
    Object.defineProperty(row, "offsetHeight", { value: 28 });
    el.append(row);
    expect(pageSteps(el, true)).toBe(1);
    expect(pageSteps(el, false)).toBe(1);
  });
});

describe("viewportIndex", () => {
  it("returns nowhere for an empty list even with a scroller", () => {
    expect(viewportIndex(null, [], "high")).toBe(-1);
    expect(viewportIndex(scroller(40), [], "low")).toBe(-1);
    expect(viewportIndex(scroller(40), [], "mid")).toBe(-1);
  });

  it("picks high, mid and low of the whole list without a viewport", () => {
    const rows = [0, 1, 2, 3, 4].map(() => rowAt(0));
    expect(viewportIndex(null, rows, "high")).toBe(0);
    expect(viewportIndex(null, rows, "mid")).toBe(2);
    expect(viewportIndex(null, rows, "low")).toBe(4);
  });

  it("mid of two rows without a viewport is the first", () => {
    const rows = [rowAt(0), rowAt(20)];
    expect(viewportIndex(null, rows, "mid")).toBe(0);
  });

  it("a zero-height scroller is the whole list, not a degenerate window", () => {
    const el = scroller(0, 10);
    const rows = [rowAt(0, 20), rowAt(20, 20), rowAt(40, 20)];
    const scrolled = scroller(0, 25);
    expect(viewportIndex(scrolled, rows, "high")).toBe(0);
    expect(viewportIndex(scrolled, rows, "low")).toBe(2);
    expect(viewportIndex(scrolled, rows, "mid")).toBe(1);
  });

  it("picks high, mid and low of three visible rows", () => {
    const el = scroller(60, 20);
    const rows = [0, 1, 2, 3, 4].map((i) => rowAt(i * 20));
    // Window [20, 80]: rows 1, 2, 3.
    expect(viewportIndex(el, rows, "high")).toBe(1);
    expect(viewportIndex(el, rows, "mid")).toBe(2);
    expect(viewportIndex(el, rows, "low")).toBe(3);
  });

  it("skips holes in the row list instead of throwing", () => {
    const el = scroller(40, 0);
    const rows = [rowAt(0), null, undefined, rowAt(20)];
    expect(viewportIndex(el, rows, "high")).toBe(0);
    expect(viewportIndex(el, rows, "low")).toBe(3);
  });

  it("a 1px scroller still windows the first overlapping row", () => {
    const el = scroller(1, 0);
    const rows = [rowAt(0, 20), rowAt(20, 20), rowAt(40, 20)];
    expect(viewportIndex(el, rows, "high")).toBe(0);
    expect(viewportIndex(el, rows, "mid")).toBe(0);
    expect(viewportIndex(el, rows, "low")).toBe(0);
  });

  it("falls back to the whole list when the window overlaps no row", () => {
    const el = scroller(40, 1000);
    const rows = [0, 1, 2, 3, 4].map((i) => rowAt(i * 20));
    expect(viewportIndex(el, rows, "high")).toBe(0);
    expect(viewportIndex(el, rows, "mid")).toBe(2);
    expect(viewportIndex(el, rows, "low")).toBe(4);
  });

  it("a single visible row is high, mid and low", () => {
    const el = scroller(20, 40);
    const rows = [0, 1, 2].map((i) => rowAt(i * 20));
    expect(viewportIndex(el, rows, "high")).toBe(2);
    expect(viewportIndex(el, rows, "mid")).toBe(2);
    expect(viewportIndex(el, rows, "low")).toBe(2);
  });
});
