/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gestureLimits } from "../lib/gestures.js";
import { StatusMark } from "./StatusMark.js";
import { STATUS_BUBBLE_MS, placeBubble } from "./status-twin.js";

const LABEL = "Refused: this request names no interaction";

/**
 * jsdom has no PointerEvent constructor; the gestures read `pointerType` and
 * the coordinates, so a MouseEvent carrying `pointerType` is what they see.
 */
function pointer(type: string, pointerType = "touch"): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

function bubble(): HTMLElement | null {
  return document.querySelector(".status-bubble");
}

function mark(): HTMLElement {
  return screen.getByRole("img", { name: LABEL });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StatusMark", () => {
  it("keeps its accessible name exactly: role img, aria-label and title", () => {
    render(<StatusMark tone="err" label={LABEL} />);
    const el = mark();
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe(LABEL);
    expect(el.getAttribute("title")).toBe(LABEL);
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.hasAttribute("data-touch-twin")).toBe(true);
  });

  it("shows the sentence on a tap", () => {
    render(<StatusMark tone="err" label={LABEL} />);
    expect(bubble()).toBeNull();
    fireEvent.click(mark());
    expect(bubble()?.textContent).toBe(LABEL);
  });

  it("shows the sentence on a long press, before the finger lifts", () => {
    render(<StatusMark tone="warn" label={LABEL} />);
    act(() => {
      mark().dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      vi.advanceTimersByTime(gestureLimits.longPressMs - 1);
    });
    expect(bubble()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(bubble()?.textContent).toBe(LABEL);
  });

  it("hides the bubble from assistive technology — the name already says it", () => {
    render(<StatusMark tone="err" label={LABEL} />);
    fireEvent.click(mark());
    expect(bubble()?.getAttribute("aria-hidden")).toBe("true");
    // Still exactly one accessible sentence.
    expect(screen.getAllByLabelText(LABEL)).toHaveLength(1);
    expect(mark().getAttribute("aria-label")).toBe(LABEL);
  });

  it("dismisses on a tap elsewhere", () => {
    render(
      <div>
        <StatusMark tone="err" label={LABEL} />
        <p>elsewhere</p>
      </div>,
    );
    fireEvent.click(mark());
    expect(bubble()).not.toBeNull();
    act(() => {
      screen.getByText("elsewhere").dispatchEvent(pointer("pointerdown"));
    });
    expect(bubble()).toBeNull();
  });

  it("stays up when the tap lands on the mark itself", () => {
    render(<StatusMark tone="err" label={LABEL} />);
    fireEvent.click(mark());
    act(() => {
      mark().dispatchEvent(pointer("pointerdown"));
    });
    expect(bubble()).not.toBeNull();
  });

  it("dismisses on Escape", () => {
    render(<StatusMark tone="err" label={LABEL} />);
    fireEvent.click(mark());
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(bubble()).toBeNull();
  });

  it("dismisses on its own after the timeout, counted from the lift", () => {
    render(<StatusMark tone="ok" label={LABEL} />);
    fireEvent.click(mark());
    act(() => {
      vi.advanceTimersByTime(STATUS_BUBBLE_MS - 1);
    });
    expect(bubble()).not.toBeNull();
    act(() => {
      mark().dispatchEvent(pointer("pointerup"));
    });
    act(() => {
      vi.advanceTimersByTime(STATUS_BUBBLE_MS - 1);
    });
    expect(bubble()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(bubble()).toBeNull();
  });

  it("stands down inside an interactive parent: the parent's click works, no bubble", () => {
    const pressed = vi.fn();
    render(
      <button type="button" onClick={pressed}>
        <StatusMark tone="ok" label={LABEL} />
        Open
      </button>,
    );
    const el = mark();
    expect(el.hasAttribute("data-touch-twin")).toBe(false);
    fireEvent.click(el);
    expect(pressed).toHaveBeenCalledTimes(1);
    act(() => {
      el.dispatchEvent(pointer("pointerdown"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(bubble()).toBeNull();
  });

  it("stands down inside a link and a listing row too", () => {
    render(
      <div>
        <a href="#x">
          <StatusMark tone="ok" label="In a link" />
        </a>
        <div role="treeitem" aria-selected="false" tabIndex={-1}>
          <StatusMark tone="ok" label="In a row" />
        </div>
      </div>,
    );
    for (const name of ["In a link", "In a row"]) {
      const el = screen.getByRole("img", { name });
      expect(el.hasAttribute("data-touch-twin")).toBe(false);
      fireEvent.click(el);
    }
    expect(bubble()).toBeNull();
  });

  it("leaves a mouse's right click to the page menu; a finger's hold is the mark's", () => {
    render(<StatusMark tone="err" label={LABEL} />);
    act(() => {
      mark().dispatchEvent(pointer("pointerdown", "mouse"));
    });
    const mouseMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    mark().dispatchEvent(mouseMenu);
    expect(mouseMenu.defaultPrevented).toBe(false);
    act(() => {
      mark().dispatchEvent(pointer("pointerdown", "touch"));
    });
    const held = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    mark().dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
  });
});

describe("placeBubble", () => {
  const rect = (left: number, top: number, size = 44) => ({
    left,
    top,
    width: size,
    bottom: top + size,
  });

  it("centres the bubble above the mark", () => {
    expect(
      placeBubble(rect(100, 200), { width: 60, height: 20 }, { width: 390 }),
    ).toEqual({ left: 92, top: 174 });
  });

  it("keeps it inside the viewport's edges", () => {
    const left = placeBubble(
      rect(0, 200),
      { width: 200, height: 20 },
      { width: 390 },
    );
    expect(left.left).toBe(8);
    const right = placeBubble(
      rect(360, 200),
      { width: 200, height: 20 },
      { width: 390 },
    );
    expect(right.left).toBe(390 - 200 - 8);
  });

  it("drops below the mark near the top edge", () => {
    expect(
      placeBubble(rect(100, 4), { width: 60, height: 20 }, { width: 390 }).top,
    ).toBe(4 + 44 + 6);
  });
});
