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
