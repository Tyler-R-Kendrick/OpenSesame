/** @vitest-environment jsdom */
/** The key capture: what a press, a blur and a refusal leave behind. */
import {
  loadKeymap,
  resetKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keymapSeams } from "../../../lib/keymap.js";
import { press, renderPanels, row, settle } from "./keybindings-test-kit.js";

afterEach(() => {
  cleanup();
  resetKeymap();
  vi.useRealTimers();
});

function openChange() {
  fireEvent.click(
    within(row("Next row")).getByRole("button", {
      name: "Change j for Next row",
    }),
  );
  return screen.getByRole("textbox", { name: /New key in place of j/ });
}

function openAdd() {
  fireEvent.click(
    within(row("Next row")).getByRole("button", {
      name: "Add a key for Next row",
    }),
  );
}

function lapse() {
  act(() => {
    vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
  });
}

describe("KeyCapture buttons on a browser that does not focus a button on press", () => {
  it("keeps focus in the field when Remove or Cancel is pressed", () => {
    renderPanels();
    openChange();
    for (const name of [/Remove j from Next row/, "Cancel"]) {
      const button = screen.getByRole("button", { name });
      expect(fireEvent.mouseDown(button)).toBe(false);
      expect(fireEvent.pointerDown(button)).toBe(false);
    }
  });

  it("still removes the key when the press blurred the field first", async () => {
    renderPanels();
    const input = openChange();
    const remove = screen.getByRole("button", {
      name: /Remove j from Next row/,
    });
    // Safari, iOS: the press blurs the field and relatedTarget is null.
    fireEvent.pointerDown(remove);
    fireEvent.mouseDown(remove);
    act(() => input.blur());
    await settle();
    fireEvent.click(remove);
    expect(loadKeymap().bindings).toEqual({ j: "nop" });
  });

  it("cancels once focus has really left, and not before", async () => {
    renderPanels();
    const input = openChange();
    act(() => input.blur());
    await settle();
    expect(screen.queryByRole("textbox", { name: /New key/ })).toBeNull();
    expect(loadKeymap().bindings).toEqual({});
  });

  it("stays open while focus is still in the field after a blur event", async () => {
    renderPanels();
    const input = openChange();
    // The window lost focus: the field is still the active element.
    fireEvent.blur(input);
    await settle();
    expect(screen.getByRole("textbox", { name: /New key/ })).toBeTruthy();
  });
});

describe("KeyCapture after a refusal", () => {
  it("clears on every identical refusal and records the next valid key", () => {
    vi.useFakeTimers();
    renderPanels();
    openAdd();
    const field = () =>
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "New key for Next row",
      });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      press("3");
      expect(field().value).toBe("3");
      lapse();
      expect(field().value).toBe("");
      expect(screen.getByRole("img", { name: /3 is fixed/ })).toBeTruthy();
    }
    press("w");
    lapse();
    expect(loadKeymap().bindings).toEqual({ w: "listing.next" });
  });
});

describe("KeyCapture announcing a refusal", () => {
  it("speaks every refusal, the same one again too, beside the mark", () => {
    vi.useFakeTimers();
    renderPanels();
    openAdd();
    const seen: HTMLElement[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      press("3");
      lapse();
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(/3 is fixed/);
      expect(alert.className).toContain("visually-hidden");
      // A new node each time: a live region only speaks what is inserted.
      expect(seen).not.toContain(alert);
      seen.push(alert);
      expect(screen.getByRole("img", { name: /3 is fixed/ })).toBeTruthy();
    }
  });
});

describe("KeyCapture and Tab", () => {
  it("drops a half-typed sequence when Tab moves on", () => {
    vi.useFakeTimers();
    renderPanels();
    openAdd();
    press("w");
    press("Tab");
    lapse();
    expect(loadKeymap().bindings).toEqual({});
  });

  it("drops it when focus moves to a key beside the field", () => {
    vi.useFakeTimers();
    renderPanels();
    openAdd();
    press("w");
    act(() => screen.getByRole("button", { name: "Cancel" }).focus());
    lapse();
    expect(loadKeymap().bindings).toEqual({});
  });
});
