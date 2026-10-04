/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gestureLimits } from "../lib/gestures.js";
import { useHold } from "./use-hold.js";

function pointer(type: string, pointerType: string): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

type Seen = { consume?: () => boolean };

function Probe({
  onHold,
  seen,
  applies,
}: {
  onHold: () => void;
  seen: Seen;
  applies?: () => boolean;
}) {
  const hold = useHold(onHold, applies);
  seen.consume = hold.consumeHold;
  return (
    <button type="button" ref={hold.bind}>
      held
    </button>
  );
}

function mount(onHold: () => void, applies?: () => boolean) {
  const seen: Seen = {};
  const view = render(<Probe onHold={onHold} seen={seen} applies={applies} />);
  return {
    button: view.getByRole("button"),
    consume: () => seen.consume?.() ?? false,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHold", () => {
  it("runs once a finger has rested, and tells the click that follows to stand down once", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { button, consume } = mount(onHold);
    act(() => {
      button.dispatchEvent(pointer("pointerdown", "touch"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(consume()).toBe(true);
    expect(consume()).toBe(false);
  });

  it("does nothing for a tap, a mouse, or a finger that left", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { button, consume } = mount(onHold);
    act(() => {
      button.dispatchEvent(pointer("pointerdown", "touch"));
      vi.advanceTimersByTime(gestureLimits.longPressMs - 100);
      button.dispatchEvent(pointer("pointerup", "touch"));
      vi.advanceTimersByTime(500);
      button.dispatchEvent(pointer("pointerdown", "mouse"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(onHold).not.toHaveBeenCalled();
    expect(consume()).toBe(false);
  });

  it("forgets an old hold when the next press begins", () => {
    vi.useFakeTimers();
    const { button, consume } = mount(() => undefined);
    act(() => {
      button.dispatchEvent(pointer("pointerdown", "touch"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
      // A press elsewhere on the page — not on the control — is a new
      // sequence too: no click is coming for the hold that has ended.
      document.body.dispatchEvent(pointer("pointerdown", "touch"));
    });
    expect(consume()).toBe(false);
  });

  it("lets go of the element when it unmounts", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { button } = mount(onHold);
    cleanup();
    act(() => {
      button.dispatchEvent(pointer("pointerdown", "touch"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(onHold).not.toHaveBeenCalled();
  });
});

describe("useHold — a hold that does not apply", () => {
  it("is not a hold: nothing runs and the click that follows stands", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { button, consume } = mount(onHold, () => false);
    act(() => {
      button.dispatchEvent(pointer("pointerdown", "touch"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(onHold).not.toHaveBeenCalled();
    expect(consume()).toBe(false);
  });

  it("asks at the moment of the hold, not when it was bound", () => {
    vi.useFakeTimers();
    let drawn = false;
    const onHold = vi.fn();
    const { button } = mount(onHold, () => drawn);
    drawn = true;
    act(() => {
      button.dispatchEvent(pointer("pointerdown", "touch"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
  });
});
