/** @vitest-environment jsdom */
import { EMPTY_KEYMAP } from "@opensesame/app-core/lib/keymap/config.js";
import {
  loadKeymap,
  resetKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetMotionAccessForTest } from "../../../lib/gesture-motion.js";
import { stubScreen } from "../../../lib/use-narrow.test-support.js";
import { renderPanels, settle } from "./keybindings-test-kit.js";

afterEach(() => {
  cleanup();
  resetKeymap();
  forgetMotionAccessForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openGestures() {
  renderPanels();
  fireEvent.click(screen.getByRole("tab", { name: "Gestures" }));
}

function gestureRow(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-gesture="${id}"]`);
  if (!found) throw new Error(`no gesture ${id}`);
  return found;
}

function choice(id: string): HTMLSelectElement {
  const found = within(gestureRow(id)).getByRole("combobox");
  if (!(found instanceof HTMLSelectElement)) throw new Error("not a choice");
  return found;
}

function stubSensor(prompt?: () => Promise<string>) {
  class Sensor extends Event {}
  if (prompt) Object.assign(Sensor, { requestPermission: prompt });
  vi.stubGlobal("DeviceMotionEvent", Sensor);
}

describe("the loadout tabs", () => {
  it("open on the keys where a mouse points, and on gestures under a finger", () => {
    stubScreen({ narrow: false, coarse: false });
    renderPanels();
    expect(
      screen
        .getByRole("tab", { name: "Keyboard" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("heading", { name: "Keymap" })).toBeTruthy();
    cleanup();
    stubScreen({ narrow: true, coarse: true });
    renderPanels();
    expect(
      screen
        .getByRole("tab", { name: "Gestures" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("heading", { name: "Gestures" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Keymap" })).toBeNull();
  });

  it("always draw both, and the macros under whichever is chosen", () => {
    renderPanels();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Keyboard",
      "Gestures",
    ]);
    expect(
      screen.getByRole("heading", { name: "Macros", level: 2 }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Gestures" }));
    expect(
      screen.getByRole("heading", { name: "Macros", level: 2 }),
    ).toBeTruthy();
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      "kb-tab-gestures",
    );
  });

  it("move with the arrow keys, Home and End, taking focus with them", () => {
    renderPanels();
    const keyboard = screen.getByRole("tab", { name: "Keyboard" });
    keyboard.focus();
    fireEvent.keyDown(keyboard, { key: "ArrowRight" });
    const gestures = screen.getByRole("tab", { name: "Gestures" });
    expect(gestures.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(gestures);
    fireEvent.keyDown(gestures, { key: "ArrowRight" });
    expect(
      screen
        .getByRole("tab", { name: "Keyboard" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(document.activeElement ?? keyboard, { key: "End" });
    expect(
      screen
        .getByRole("tab", { name: "Gestures" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(document.activeElement ?? gestures, { key: "Home" });
    expect(
      screen
        .getByRole("tab", { name: "Keyboard" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(document.activeElement ?? keyboard, { key: "ArrowUp" });
    expect(
      screen
        .getByRole("tab", { name: "Keyboard" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keep one tab in the tab order", () => {
    renderPanels();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1]);
  });
});

describe("Settings › Keybindings › Gestures", () => {
  it("draws a row per gesture with what it runs", () => {
    openGestures();
    expect(
      [...document.querySelectorAll("[data-gesture]")].map((row) =>
        row.getAttribute("data-gesture"),
      ),
    ).toEqual([
      "two-finger-swipe-left",
      "two-finger-swipe-right",
      "two-finger-swipe-up",
      "two-finger-swipe-down",
      "two-finger-tap",
      "shake",
    ]);
    expect(choice("two-finger-swipe-up").value).toBe("listing.last");
    expect(choice("two-finger-tap").value).toBe("command.palette");
    expect(choice("shake").value).toBe("help.keymap");
    expect(document.querySelector("[data-changed]")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Reset every gesture/ }),
    ).toBeNull();
  });

  it("lists the fixed gestures under the lock", () => {
    openGestures();
    const fixed = screen
      .getByRole("heading", { name: "Fixed" })
      .closest("section");
    expect(fixed?.textContent).toContain("Hold, or swipe a row left");
    expect(fixed?.textContent).toContain("Actions for the row");
    expect(fixed?.textContent).toContain("Pinch");
  });

  it("binds a gesture to another action, and says it changed", () => {
    openGestures();
    fireEvent.change(choice("two-finger-tap"), {
      target: { value: "item.new" },
    });
    expect(loadKeymap().gestures).toEqual({ "two-finger-tap": "item.new" });
    expect(gestureRow("two-finger-tap").hasAttribute("data-changed")).toBe(
      true,
    );
    expect(choice("two-finger-tap").value).toBe("item.new");
  });

  it("strikes a gesture with no action, and brings it back with its reset key", () => {
    openGestures();
    fireEvent.change(choice("shake"), { target: { value: "" } });
    expect(loadKeymap().gestures).toEqual({ shake: "nop" });
    expect(choice("shake").value).toBe("");
    fireEvent.click(
      within(gestureRow("shake")).getByRole("button", {
        name: "Reset Shake the phone to its default",
      }),
    );
    expect(loadKeymap().gestures).toBeUndefined();
    expect(choice("shake").value).toBe("help.keymap");
  });

  it("never offers a command that asks first or a register key", () => {
    openGestures();
    const labels = within(choice("shake"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toContain("Favorite");
    expect(labels).not.toContain("Move to trash");
    expect(labels).not.toContain("Share once");
    expect(labels).not.toContain("Delete permanently");
    expect(labels).not.toContain("Record a macro into a register");
  });

  it("offers the person's macros, and runs one from a gesture", () => {
    saveKeymap({
      ...EMPTY_KEYMAP,
      macros: { top: { steps: [{ command: "listing.first", count: 1 }] } },
    });
    openGestures();
    const names = within(choice("shake"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(names).toContain("@top");
    fireEvent.change(choice("shake"), { target: { value: "macro.top" } });
    expect(loadKeymap().gestures).toEqual({ shake: "macro.top" });
  });

  it("keeps a gesture's target the plan does not have, under its own heading", () => {
    saveKeymap({ ...EMPTY_KEYMAP, gestures: { shake: "section.gone" } });
    openGestures();
    expect(choice("shake").value).toBe("section.gone");
    const group = within(choice("shake")).getByRole("group", {
      name: "Not on this plan",
    });
    expect(group.textContent).toBe("section.gone");
  });

  it("says so, and keeps the gestures, when storage will not take a change", () => {
    openGestures();
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    fireEvent.change(choice("shake"), { target: { value: "item.new" } });
    set.mockRestore();
    expect(screen.getByRole("alert").textContent).toBe(
      "The keymap could not be saved on this device.",
    );
    expect(loadKeymap().gestures).toBeUndefined();
    expect(choice("shake").value).toBe("help.keymap");
  });

  it("resets every gesture from its head, and only then draws the key", () => {
    saveKeymap({
      ...EMPTY_KEYMAP,
      bindings: { w: "listing.next" },
      gestures: { shake: "nop", "two-finger-tap": "item.new" },
    });
    openGestures();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset every gesture to its default",
      }),
    );
    expect(loadKeymap().gestures).toBeUndefined();
    // The keys are the other tab's: untouched.
    expect(loadKeymap().bindings).toEqual({ w: "listing.next" });
    expect(
      screen.queryByRole("button", {
        name: "Reset every gesture to its default",
      }),
    ).toBeNull();
  });
});

describe("the keyboard tab's reset leaves the gestures alone", () => {
  it("forgets keys and macros, keeps a gesture that names no macro", () => {
    saveKeymap({
      ...EMPTY_KEYMAP,
      bindings: { w: "listing.next" },
      macros: { top: { steps: [{ command: "listing.first", count: 1 }] } },
      gestures: { "two-finger-tap": "item.new", shake: "macro.top" },
    });
    renderPanels();
    const all = screen.getByRole("button", {
      name: "Reset every key and macro",
    });
    fireEvent.click(all);
    fireEvent.click(all);
    expect(loadKeymap().bindings).toEqual({});
    expect(loadKeymap().macros).toEqual({});
    expect(loadKeymap().gestures).toEqual({ "two-finger-tap": "item.new" });
  });
});

describe("the shake switch", () => {
  it("is absent where the browser has no motion sensor", () => {
    openGestures();
    expect(
      screen.queryByRole("switch", { name: /moving the phone/ }),
    ).toBeNull();
  });

  it("turns motion off and on, and marks the shake while it is off", () => {
    stubSensor();
    openGestures();
    const motion = screen.getByRole("switch", {
      name: "Gestures made by moving the phone",
    });
    expect(motion.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(motion);
    expect(loadKeymap().motion).toBe(false);
    expect(motion.getAttribute("aria-checked")).toBe("false");
    expect(
      within(gestureRow("shake")).getByRole("img", {
        name: "Motion is off: a shake does nothing",
      }),
    ).toBeTruthy();
    fireEvent.click(motion);
    expect(loadKeymap().motion).toBeUndefined();
  });

  it("draws an Allow key only where the browser asks first, and asks only when pressed", async () => {
    const prompt = vi.fn(async () => "granted");
    stubSensor(prompt);
    openGestures();
    expect(prompt).not.toHaveBeenCalled();
    const allow = screen.getByRole("button", {
      name: "Allow this site to read the phone's motion",
    });
    await act(async () => {
      fireEvent.click(allow);
      await Promise.resolve();
    });
    await settle();
    expect(prompt).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", {
        name: "Allow this site to read the phone's motion",
      }),
    ).toBeNull();
  });

  it("says when the browser blocked it", async () => {
    stubSensor(async () => "denied");
    openGestures();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Allow this site to read the phone's motion",
        }),
      );
      await Promise.resolve();
    });
    await settle();
    expect(
      screen.getByRole("img", {
        name: "Motion is blocked for this site: allow it in the browser's site settings",
      }),
    ).toBeTruthy();
  });
});
