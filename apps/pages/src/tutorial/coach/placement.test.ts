import { describe, expect, it } from "vitest";
import {
  type Box,
  COACH_GAP,
  COACH_MARGIN,
  type PlacementInput,
  clearOfDock,
  placeCoach,
} from "./placement.js";

const VIEWPORT = { width: 1280, height: 800 };
const CARD = { width: 368, height: 170 };

function input(over: Partial<PlacementInput>): PlacementInput {
  return {
    viewport: VIEWPORT,
    card: CARD,
    target: null,
    prefer: null,
    phone: false,
    ...over,
  };
}

function boxOf(placed: { left: number; top: number }): Box {
  return { left: placed.left, top: placed.top, ...CARD };
}

function overlap(a: Box, b: Box): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

describe("placeCoach", () => {
  it("centres a step that points at nothing", () => {
    const placed = placeCoach(input({}));
    expect(placed).toEqual({
      kind: "centered",
      left: (1280 - CARD.width) / 2,
      top: (800 - CARD.height) / 2,
    });
  });

  it("takes the side the author preferred when it fits", () => {
    const target: Box = { left: 600, top: 300, width: 80, height: 40 };
    for (const prefer of ["top", "right", "bottom", "left"] as const) {
      const placed = placeCoach(input({ target, prefer }));
      expect(placed.kind).toBe("anchored");
      if (placed.kind !== "anchored") continue;
      const opposite = {
        top: "bottom",
        bottom: "top",
        left: "right",
        right: "left",
      }[prefer];
      expect(placed.facing).toBe(opposite);
      expect(overlap(boxOf(placed), target)).toBe(false);
    }
  });

  it("keeps the gap between the card and the control it is about", () => {
    const target: Box = { left: 600, top: 100, width: 80, height: 40 };
    const placed = placeCoach(input({ target, prefer: "bottom" }));
    if (placed.kind !== "anchored") throw new Error("expected anchored");
    expect(placed.top).toBe(target.top + target.height + COACH_GAP);
  });

  it("flips to the other side when the preferred one has no room", () => {
    // A control on the bottom edge: the card cannot go below it.
    const target: Box = { left: 600, top: 740, width: 80, height: 40 };
    const placed = placeCoach(input({ target, prefer: "bottom" }));
    expect(placed.kind).toBe("anchored");
    if (placed.kind !== "anchored") return;
    expect(placed.facing).toBe("bottom");
    expect(boxOf(placed).top + CARD.height).toBeLessThanOrEqual(
      target.top - COACH_GAP + 1,
    );
  });

  it("stays inside the viewport at every edge", () => {
    const targets: Box[] = [
      { left: 0, top: 0, width: 60, height: 40 },
      { left: 1220, top: 0, width: 60, height: 40 },
      { left: 0, top: 760, width: 60, height: 40 },
      { left: 1220, top: 760, width: 60, height: 40 },
      { left: 620, top: 380, width: 40, height: 40 },
    ];
    for (const target of targets) {
      for (const prefer of [null, "top", "right", "bottom", "left"] as const) {
        const placed = placeCoach(input({ target, prefer }));
        if (placed.kind === "dock" || placed.kind === "centered") continue;
        const box = boxOf(placed);
        expect(box.left).toBeGreaterThanOrEqual(COACH_MARGIN - 1);
        expect(box.top).toBeGreaterThanOrEqual(COACH_MARGIN - 1);
        expect(box.left + box.width).toBeLessThanOrEqual(
          1280 - COACH_MARGIN + 1,
        );
        expect(box.top + box.height).toBeLessThanOrEqual(
          800 - COACH_MARGIN + 1,
        );
        expect(overlap(box, target)).toBe(false);
      }
    }
  });

  it("never covers a control as large as the screen", () => {
    const target: Box = { left: 0, top: 0, width: 1280, height: 800 };
    const placed = placeCoach(input({ target }));
    expect(placed.kind).toBe("floating");
  });

  it("points the notch at the middle of the control, clear of the corners", () => {
    const target: Box = { left: 300, top: 100, width: 40, height: 40 };
    const placed = placeCoach(input({ target, prefer: "bottom" }));
    if (placed.kind !== "anchored") throw new Error("expected anchored");
    expect(placed.left + placed.notch).toBeCloseTo(320, -1);
    const edge = placeCoach(
      input({
        target: { left: 4, top: 100, width: 20, height: 20 },
        prefer: "bottom",
      }),
    );
    if (edge.kind !== "anchored") throw new Error("expected anchored");
    expect(edge.notch).toBeGreaterThanOrEqual(14);
  });

  it("docks to the edge the control is not on, on a phone", () => {
    const phone = { viewport: { width: 390, height: 844 }, phone: true };
    const high = placeCoach(
      input({ ...phone, target: { left: 20, top: 60, width: 44, height: 44 } }),
    );
    expect(high).toEqual({ kind: "dock", edge: "bottom" });
    const low = placeCoach(
      input({
        ...phone,
        target: { left: 20, top: 760, width: 44, height: 44 },
      }),
    );
    expect(low).toEqual({ kind: "dock", edge: "top" });
    expect(placeCoach(input({ ...phone }))).toEqual({
      kind: "dock",
      edge: "bottom",
    });
  });
});

describe("clearOfDock", () => {
  const viewport = { width: 390, height: 800 };
  const card = { width: 366, height: 180 };

  it("cuts a pane-sized target back to what the top dock leaves", () => {
    const lit = clearOfDock(
      { left: 0, top: 60, width: 390, height: 700 },
      viewport,
      card,
      "top",
    );
    expect(lit.top).toBe(204);
    expect(lit.top + lit.height).toBe(760);
  });

  it("cuts it back from the bottom for a bottom dock", () => {
    const lit = clearOfDock(
      { left: 0, top: 60, width: 390, height: 740 },
      viewport,
      card,
      "bottom",
    );
    expect(lit.top).toBe(60);
    expect(lit.top + lit.height).toBe(596);
  });

  it("leaves a small control alone", () => {
    const hole = { left: 300, top: 600, width: 44, height: 44 };
    expect(clearOfDock(hole, viewport, card, "top")).toEqual(hole);
  });
});
