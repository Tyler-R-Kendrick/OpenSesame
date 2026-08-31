/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { gestureLimits, longPress, swipeBack } from "./gestures.js";

/** What a synthetic pointer needs to carry for the gestures to read it. */
type PointerInit = {
  x?: number;
  y?: number;
  pointerType?: string;
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
