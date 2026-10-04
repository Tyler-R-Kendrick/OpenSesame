/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimHorizontalDrags,
  gestureLimits,
  longPress,
  swipe,
  swipeBack,
} from "./gestures.js";

/** What a synthetic pointer needs to carry for the gestures to read it. */
type PointerInit = {
  x?: number;
  y?: number;
  pointerType?: string;
  /** Which finger: a second one makes the touch two-fingered. */
  id?: number;
};

/**
 * A pointer event jsdom will dispatch, carrying the fields the gestures
 * read. jsdom has no PointerEvent constructor, so this is a MouseEvent —
 * which already carries clientX/clientY/timeStamp — with `pointerType`
 * defined on it. It is returned as an Event because dispatching is all a
 * caller does with it, which keeps the fake honest about what it is.
 */
function pointer(type: string, init: PointerInit = {}): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
  });
  Object.defineProperty(event, "pointerType", {
    value: init.pointerType ?? "touch",
  });
  Object.defineProperty(event, "pointerId", { value: init.id ?? 1 });
  return event;
}

function mount(): HTMLDivElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("swipeBack", () => {
  it("fires on a rightward drag past the threshold", () => {
    const el = mount();
    const back = vi.fn();
    swipeBack(el, back);
    el.dispatchEvent(pointer("pointerdown", { x: 10, y: 100 }));
    el.dispatchEvent(
      pointer("pointerup", { x: 10 + gestureLimits.swipeMinX + 5, y: 108 }),
    );
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("ignores a vertical drag — that is a scroll, not a swipe", () => {
    const el = mount();
    const back = vi.fn();
    swipeBack(el, back);
    el.dispatchEvent(pointer("pointerdown", { x: 10, y: 100 }));
    el.dispatchEvent(
      pointer("pointerup", {
        x: 10 + gestureLimits.swipeMinX + 5,
        y: 100 + gestureLimits.swipeMaxY + 10,
      }),
    );
    expect(back).not.toHaveBeenCalled();
  });

  it("ignores a leftward drag and a short one", () => {
    const el = mount();
    const back = vi.fn();
    swipeBack(el, back);
    el.dispatchEvent(pointer("pointerdown", { x: 200, y: 50 }));
    el.dispatchEvent(pointer("pointerup", { x: 100, y: 50 }));
    el.dispatchEvent(pointer("pointerdown", { x: 10, y: 50 }));
    el.dispatchEvent(pointer("pointerup", { x: 30, y: 50 }));
    expect(back).not.toHaveBeenCalled();
  });

  it("leaves the mouse alone: a drag with a mouse is a selection", () => {
    const el = mount();
    const back = vi.fn();
    swipeBack(el, back);
    el.dispatchEvent(
      pointer("pointerdown", { x: 10, y: 50, pointerType: "mouse" }),
    );
    el.dispatchEvent(
      pointer("pointerup", { x: 300, y: 50, pointerType: "mouse" }),
    );
    expect(back).not.toHaveBeenCalled();
  });

  it("stops listening once disposed", () => {
    const el = mount();
    const back = vi.fn();
    swipeBack(el, back)();
    el.dispatchEvent(pointer("pointerdown", { x: 10, y: 50 }));
    el.dispatchEvent(pointer("pointerup", { x: 300, y: 50 }));
    expect(back).not.toHaveBeenCalled();
  });
});

describe("longPress", () => {
  it("fires after the hold", () => {
    vi.useFakeTimers();
    const el = mount();
    const hold = vi.fn();
    longPress(el, hold);
    el.dispatchEvent(pointer("pointerdown", { x: 40, y: 40 }));
    vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it("abandons the hold when the finger wanders — that is a scroll", () => {
    vi.useFakeTimers();
    const el = mount();
    const hold = vi.fn();
    longPress(el, hold);
    el.dispatchEvent(pointer("pointerdown", { x: 40, y: 40 }));
    el.dispatchEvent(
      pointer("pointermove", {
        x: 40,
        y: 40 + gestureLimits.longPressSlop + 5,
      }),
    );
    vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    expect(hold).not.toHaveBeenCalled();
  });

  it("abandons the hold when the finger lifts early — that is a tap", () => {
    vi.useFakeTimers();
    const el = mount();
    const hold = vi.fn();
    longPress(el, hold);
    el.dispatchEvent(pointer("pointerdown", { x: 40, y: 40 }));
    vi.advanceTimersByTime(gestureLimits.longPressMs - 50);
    el.dispatchEvent(pointer("pointerup", { x: 40, y: 40 }));
    vi.advanceTimersByTime(200);
    expect(hold).not.toHaveBeenCalled();
  });

  it("leaves the mouse alone: hovering is not holding", () => {
    vi.useFakeTimers();
    const el = mount();
    const hold = vi.fn();
    longPress(el, hold);
    el.dispatchEvent(
      pointer("pointerdown", { x: 40, y: 40, pointerType: "mouse" }),
    );
    vi.advanceTimersByTime(gestureLimits.longPressMs + 50);
    expect(hold).not.toHaveBeenCalled();
  });

  it("stops listening once disposed", () => {
    vi.useFakeTimers();
    const el = mount();
    const hold = vi.fn();
    longPress(el, hold)();
    el.dispatchEvent(pointer("pointerdown", { x: 40, y: 40 }));
    vi.advanceTimersByTime(gestureLimits.longPressMs + 50);
    expect(hold).not.toHaveBeenCalled();
  });
});

describe("two fingers are not a one-finger swipe", () => {
  /** Two fingers go down, travel `dx`, and lift, one after the other. */
  function twoFingers(el: HTMLElement, dx: number) {
    el.dispatchEvent(pointer("pointerdown", { x: 100, y: 100, id: 1 }));
    el.dispatchEvent(pointer("pointerdown", { x: 180, y: 100, id: 2 }));
    el.dispatchEvent(pointer("pointerup", { x: 100 + dx, y: 100, id: 1 }));
    el.dispatchEvent(pointer("pointerup", { x: 180 + dx, y: 100, id: 2 }));
  }

  it("never opens a row's menu or goes back, so the keymap's gesture is the only one", () => {
    const el = mount();
    const menu = vi.fn();
    const back = vi.fn();
    swipe(el, "left", menu);
    swipeBack(el, back);
    twoFingers(el, -120);
    twoFingers(el, 120);
    expect(menu).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it("hears one finger again once both have lifted", () => {
    const el = mount();
    const back = vi.fn();
    swipeBack(el, back);
    twoFingers(el, 120);
    el.dispatchEvent(pointer("pointerdown", { x: 10, y: 100 }));
    el.dispatchEvent(
      pointer("pointerup", { x: 10 + gestureLimits.swipeMinX + 5, y: 100 }),
    );
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("forgets a finger that was cancelled", () => {
    const el = mount();
    const back = vi.fn();
    swipeBack(el, back);
    el.dispatchEvent(pointer("pointerdown", { x: 100, y: 100, id: 1 }));
    el.dispatchEvent(pointer("pointerdown", { x: 180, y: 100, id: 2 }));
    el.dispatchEvent(pointer("pointercancel", { id: 1 }));
    el.dispatchEvent(pointer("pointercancel", { id: 2 }));
    el.dispatchEvent(pointer("pointerdown", { x: 10, y: 100 }));
    el.dispatchEvent(
      pointer("pointerup", { x: 10 + gestureLimits.swipeMinX + 5, y: 100 }),
    );
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("swipe", () => {
  it("fires on a leftward drag, naming the element it started on", () => {
    const el = mount();
    const child = document.createElement("span");
    el.append(child);
    const on = vi.fn();
    swipe(el, "left", on);
    child.dispatchEvent(pointer("pointerdown", { x: 300, y: 100 }));
    el.dispatchEvent(
      pointer("pointerup", { x: 300 - gestureLimits.swipeMinX - 5, y: 104 }),
    );
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[1]).toBe(child);
  });

  it("a left swipe ignores a rightward drag, and back ignores a leftward one", () => {
    const el = mount();
    const left = vi.fn();
    const back = vi.fn();
    swipe(el, "left", left);
    swipeBack(el, back);
    el.dispatchEvent(pointer("pointerdown", { x: 10, y: 100 }));
    el.dispatchEvent(pointer("pointerup", { x: 120, y: 100 }));
    expect(left).not.toHaveBeenCalled();
    expect(back).toHaveBeenCalledTimes(1);
    el.dispatchEvent(pointer("pointerdown", { x: 300, y: 100 }));
    el.dispatchEvent(pointer("pointerup", { x: 190, y: 100 }));
    expect(left).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("a mouse never swipes", () => {
    const el = mount();
    const on = vi.fn();
    swipe(el, "left", on);
    el.dispatchEvent(
      pointer("pointerdown", { x: 300, y: 100, pointerType: "mouse" }),
    );
    el.dispatchEvent(
      pointer("pointerup", { x: 100, y: 100, pointerType: "mouse" }),
    );
    expect(on).not.toHaveBeenCalled();
  });
});

type Point = { x: number; y: number };

/** A touch event jsdom will dispatch, carrying the fields the claim reads. */
function touchEvent(type: string, cancelable: boolean, points: Point[]): Event {
  const event = new Event(type, { bubbles: true, cancelable });
  Object.defineProperty(event, "touches", {
    value: points.map((point) => ({ clientX: point.x, clientY: point.y })),
  });
  return event;
}

function touch(type: string, ...points: Point[]): Event {
  return touchEvent(type, true, points);
}

describe("claimHorizontalDrags", () => {
  it("cancels a drag that has gone sideways, so the browser starts no fling", () => {
    const el = mount();
    claimHorizontalDrags(el);
    el.dispatchEvent(touch("touchstart", { x: 300, y: 100 }));
    const first = touch("touchmove", { x: 260, y: 102 });
    el.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    // Claimed for the rest of the touch, even where it wobbles upward.
    const wobble = touch("touchmove", { x: 255, y: 150 });
    el.dispatchEvent(wobble);
    expect(wobble.defaultPrevented).toBe(true);
  });

  it("leaves a vertical scroll alone, and a drag too small to tell", () => {
    const el = mount();
    claimHorizontalDrags(el);
    el.dispatchEvent(touch("touchstart", { x: 300, y: 100 }));
    const tiny = touch("touchmove", {
      x: 300 - gestureLimits.dragClaimSlop,
      y: 100,
    });
    el.dispatchEvent(tiny);
    expect(tiny.defaultPrevented).toBe(false);
    const scroll = touch("touchmove", { x: 290, y: 180 });
    el.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
    // A scroll that began vertically is not taken over when it drifts.
    const drift = touch("touchmove", { x: 200, y: 185 });
    el.dispatchEvent(drift);
    expect(drift.defaultPrevented).toBe(false);
  });

  it("forgets the claim when the touch ends, and leaves a pinch alone", () => {
    const el = mount();
    claimHorizontalDrags(el);
    el.dispatchEvent(touch("touchstart", { x: 300, y: 100 }));
    el.dispatchEvent(touch("touchmove", { x: 240, y: 100 }));
    el.dispatchEvent(touch("touchend"));
    el.dispatchEvent(touch("touchstart", { x: 300, y: 100 }));
    const next = touch("touchmove", { x: 300, y: 160 });
    el.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
    el.dispatchEvent(
      touch("touchstart", { x: 300, y: 100 }, { x: 100, y: 100 }),
    );
    const pinch = touch("touchmove", { x: 200, y: 100 }, { x: 100, y: 100 });
    el.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(false);
  });

  it("does not try to cancel what the browser already took", () => {
    const el = mount();
    claimHorizontalDrags(el);
    el.dispatchEvent(touch("touchstart", { x: 300, y: 100 }));
    const late = touchEvent("touchmove", false, [{ x: 200, y: 100 }]);
    el.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(false);
  });

  it("stands down when disposed", () => {
    const el = mount();
    const stop = claimHorizontalDrags(el);
    stop();
    el.dispatchEvent(touch("touchstart", { x: 300, y: 100 }));
    const move = touch("touchmove", { x: 200, y: 100 });
    el.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
  });
});
