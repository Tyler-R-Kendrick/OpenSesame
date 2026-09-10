/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createKeymapHandler } from "./keymap.js";

afterEach(() => document.body.replaceChildren());

it("leaves searchable rail tab stops and native button activation to the browser", () => {
  const tree = document.createElement("nav");
  tree.className = "railtree";
  const search = document.createElement("input");
  const more = document.createElement("button");
  tree.append(search, more);
  document.body.append(tree);
  const handler = createKeymapHandler({ navigate: vi.fn(), showHelp: vi.fn() });
  for (const [target, key] of [
    [tree, "Tab"],
    [search, "j"],
    [more, "Enter"],
    [more, " "],
    [more, "Tab"],
  ] as const) {
    const event = new KeyboardEvent("keydown", { key, cancelable: true });
    window.addEventListener("keydown", handler, { capture: true, once: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
});

it.each(["a", "button", "summary"])(
  "preserves Enter and Space on %s, including nested targets",
  (tag) => {
    const control = document.createElement(tag);
    if (tag === "a") control.setAttribute("href", "/vault/new");
    const child = document.createElement("span");
    control.append(child);
    document.body.append(control);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    for (const target of [control, child]) {
      for (const key of ["Enter", " "]) {
        const event = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        });
        window.addEventListener("keydown", handler, {
          capture: true,
          once: true,
        });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
    }
  },
);

it.each(["railtree", "vtree__rows"])(
  "never traps Tab or Shift-Tab inside %s",
  (className) => {
    const tree = document.createElement("div");
    tree.className = className;
    tree.tabIndex = 0;
    document.body.append(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      window.addEventListener("keydown", handler, {
        capture: true,
        once: true,
      });
      tree.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  },
);
