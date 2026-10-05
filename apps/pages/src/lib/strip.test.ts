/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { revealInStrip } from "./strip.js";

type Box = { left: number; right: number };

/** A strip 320 wide holding one tab, laid out by hand: jsdom has no layout. */
function stripWith(tab: Box, scrollWidth = 540): [HTMLElement, HTMLElement] {
  const strip = document.createElement("nav");
  const item = document.createElement("a");
  strip.append(item);
  Object.defineProperty(strip, "scrollWidth", { value: scrollWidth });
  Object.defineProperty(strip, "clientWidth", { value: 320 });
  strip.getBoundingClientRect = () => new DOMRect(0, 0, 320, 0);
  item.getBoundingClientRect = () =>
    new DOMRect(tab.left, 0, tab.right - tab.left, 0);
  return [strip, item];
}

describe("revealInStrip", () => {
  it("leaves a tab that is already in view alone", () => {
    const [strip, item] = stripWith({ left: 40, right: 100 });
    revealInStrip(item);
    expect(strip.scrollLeft).toBe(0);
  });

  it("leaves a strip that fits alone", () => {
    const [strip, item] = stripWith({ left: 287, right: 338 }, 320);
    revealInStrip(item);
    expect(strip.scrollLeft).toBe(0);
  });

  it("lines a tab hidden past the right edge up with the start", () => {
    // The selected tab is 18px past the edge. Scrolling only far enough to
    // clear it stops short of a snap point and the strip snaps back; the
    // scroll has to end where the tab starts.
    const [strip, item] = stripWith({ left: 287, right: 338 });
    revealInStrip(item);
    expect(strip.scrollLeft).toBe(287 - 16);
  });

  it("lines a tab hidden past the left edge up with the start", () => {
    const [strip, item] = stripWith({ left: -30, right: 20 });
    strip.scrollLeft = 100;
    revealInStrip(item);
    expect(strip.scrollLeft).toBe(100 + (-30 - 16));
  });
});
