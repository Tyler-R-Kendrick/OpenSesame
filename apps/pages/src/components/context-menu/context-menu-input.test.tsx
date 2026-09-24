/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gestureLimits } from "../../lib/gestures.js";
import { ContextMenuLayer } from "./ContextMenuLayer.js";
import { closeContextMenu } from "./menu-model.js";

/**
 * jsdom has no PointerEvent constructor: a MouseEvent carrying
 * `pointerType` is what the recogniser reads (as in `gestures.test.ts`).
 */
function pointer(type: string, pointerType = "touch", x = 20, y = 30): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

function hold(target: Element, pointerType = "touch") {
  act(() => {
    target.dispatchEvent(pointer("pointerdown", pointerType));
    vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
  });
}

function lift(target: Element, pointerType = "touch") {
  act(() => {
    target.dispatchEvent(pointer("pointerup", pointerType));
  });
}

const pressed = vi.fn();

function page() {
  render(
    <MemoryRouter>
      <div role="tree" aria-label="Listing">
        <button type="button" onClick={pressed}>
          Row
        </button>
      </div>
      <p>Body text a finger selects</p>
      <input aria-label="field" />
      <ContextMenuLayer />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  pressed.mockClear();
});

afterEach(() => {
  act(() => closeContextMenu());
  cleanup();
  vi.useRealTimers();
});

describe("a finger held still", () => {
  it("opens the menu for what it rests on, and the lift does not also tap", () => {
    page();
    const row = screen.getByRole("button", { name: "Row" });
    hold(row);
    expect(screen.getByRole("menu", { name: "Page actions" })).toBeTruthy();
    lift(row);
    fireEvent.click(row);
    expect(pressed).not.toHaveBeenCalled();
    // The next tap is a tap again.
    act(() => {
      row.dispatchEvent(pointer("pointerdown"));
    });
    lift(row);
    fireEvent.click(row);
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it("is a scroll, not a hold, once the finger wanders", () => {
    page();
    const row = screen.getByRole("button", { name: "Row" });
    act(() => {
      row.dispatchEvent(pointer("pointerdown"));
      row.dispatchEvent(pointer("pointermove", "touch", 20, 30 + 40));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leaves a mouse and a text field to their own press-and-hold", () => {
    page();
    hold(screen.getByRole("button", { name: "Row" }), "mouse");
    expect(screen.queryByRole("menu")).toBeNull();
    hold(screen.getByLabelText("field"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leaves body text to the platform's own select-and-copy", () => {
    page();
    const text = screen.getByText("Body text a finger selects");
    hold(text);
    expect(screen.queryByRole("menu")).toBeNull();
    // Nor does the browser's own long-press event get taken from it.
    const native = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      text.dispatchEvent(native);
    });
    expect(native.defaultPrevented).toBe(false);
  });

  it("works for a stylus the same as a finger", () => {
    page();
    hold(screen.getByRole("button", { name: "Row" }), "pen");
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});

describe("the keys that ask for a menu", () => {
  it("keeps Shift+Enter's native meaning off a listing", () => {
    page();
    // The row's own button inside the listing, not the listing itself.
    const row = screen.getByRole("button", { name: "Row" });
    row.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ignores the auto-repeat of the key that opened it", () => {
    page();
    const tree = screen.getByRole("tree", { name: "Listing" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "Enter", shiftKey: true });
    const [first] = screen.getAllByRole("menuitem");
    if (!first) throw new Error("the menu has no entries");
    fireEvent.keyDown(first, { key: "Enter", shiftKey: true, repeat: true });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(first);
  });

  it("answers the Menu key on whatever holds focus", () => {
    page();
    const row = screen.getByRole("button", { name: "Row" });
    row.focus();
    fireEvent.keyDown(row, { key: "ContextMenu" });
    const [first] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(first);
  });
});

describe("the phone arrangement", () => {
  const original = window.matchMedia;
  beforeEach(() => {
    // jsdom has no matchMedia; the layer reads only `matches`.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("pointer: coarse"),
      }),
    });
  });
  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: original,
    });
  });

  it("is an action sheet named for what it is about, over a scrim that only closes", () => {
    page();
    const row = screen.getByRole("button", { name: "Row" });
    hold(row);
    const menu = screen.getByRole("menu", { name: "Page actions" });
    expect(menu.className).toContain("ctxmenu--sheet");
    expect(menu.querySelector(".ctxmenu__title")?.textContent).toBe(
      "Page actions",
    );
    lift(row);
    const scrim = screen.getByRole("button", { name: "Close menu" });
    // Asking the scrim for a menu is not asking the page beneath it.
    fireEvent.contextMenu(scrim);
    expect(
      screen.getByRole("menu", { name: "Page actions" }).className,
    ).toContain("ctxmenu--sheet");
    // The tap that dismisses lands on the scrim, never on what is beneath.
    act(() => {
      scrim.dispatchEvent(pointer("pointerdown"));
    });
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(scrim);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(pressed).not.toHaveBeenCalled();
  });
});
