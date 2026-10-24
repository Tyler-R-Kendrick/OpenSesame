/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUnlockHeroLayout } from "./use-unlock-hero-layout.js";

function element(left: number, top: number, width: number, height: number) {
  const node = document.createElement("div");
  // SAFETY: the hook reads only the box edges and size, which this fixture rect sets; it never calls toJSON or reads x and y.
  node.getBoundingClientRect = () =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    }) as DOMRect;
  return { current: node };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lets the wide hero span the left pane independently of the narrower form", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const pane = element(0, 0, 1663, 946);
  const card = element(293, 286, 352, 430);
  const notes = element(831.5, 0, 831.5, 946);
  const { result } = renderHook(() => useUnlockHeroLayout(pane, card, notes));
  const hero = result.current;
  expect(hero.left).toBeGreaterThan(75);
  expect(hero.left).toBeLessThan(85);
  expect(hero.top).toBeGreaterThan(145);
  expect(hero.top).toBeLessThan(155);
  expect(hero.size * 7.78).toBeGreaterThan(680);
  expect(hero.left + hero.size * 7.78).toBeLessThanOrEqual(831.5 - 24);
  expect(hero.top + hero.size * 1.05).toBeLessThan(
    card.current.getBoundingClientRect().top,
  );
});

it("reserves a separate hero band on a phone and fits within the form gutter", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const pane = element(0, 0, 320, 568);
  const card = element(20, 120, 280, 430);
  const notes = element(20, 570, 280, 120);
  const { result } = renderHook(() => useUnlockHeroLayout(pane, card, notes));
  const hero = result.current;
  expect(hero.left).toBe(20);
  expect(hero.left + hero.size * 7.78).toBeLessThanOrEqual(300);
  expect(hero.top + hero.size * 1.05).toBeLessThanOrEqual(100);
  expect(Number.parseFloat(pane.current.style.paddingTop)).toBeGreaterThan(80);
});
