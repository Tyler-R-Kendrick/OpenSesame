/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type VaultKeymapTarget,
  createKeymapHandler,
  registerRailKeymap,
  registerVaultKeymap,
} from "./keymap.js";

/**
 * Chaos: overlapping chords, a live timer, a dialog appearing mid-sequence,
 * and a count that would overflow.
 */

function target(): VaultKeymapTarget {
  return {
    next: vi.fn(),
    previous: vi.fn(),
    first: vi.fn(),
    last: vi.fn(),
    enter: vi.fn(),
    parent: vi.fn(),
    activate: vi.fn(),
    page: vi.fn(),
    edge: vi.fn(),
    focus: vi.fn(),
    toIndex: vi.fn(),
    search: vi.fn(),
    closeSearch: vi.fn(),
    copySecret: vi.fn(),
    copyUsername: vi.fn(),
    edit: vi.fn(),
    trash: vi.fn(),
    create: vi.fn(),
    favorite: vi.fn(),
    share: vi.fn(),
  };
}

function press(
  handler: (event: KeyboardEvent) => void,
  key: string,
  init: KeyboardEventInit = {},
) {
  handler(new KeyboardEvent("keydown", { key, cancelable: true, ...init }));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("chaos — listing keymap under overlapping input", () => {
  it("chaos: a digit run longer than the cap still moves a bounded count", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    for (const digit of "9999999") press(handler, digit);
    press(handler, "j");
    expect(tree.next).toHaveBeenCalledWith(999);
    release();
  });

  it("chaos: g times out while a count is pending, then j uses the count", () => {
    vi.useFakeTimers();
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "4");
    press(handler, "g");
    vi.advanceTimersByTime(600);
    press(handler, "j");
    expect(tree.first).not.toHaveBeenCalled();
    expect(tree.next).toHaveBeenCalledWith(4);
    release();
  });

  it("chaos: a dialog popping up mid-chord discards g and the count", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "8");
    press(handler, "g");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    press(handler, "j");
    expect(tree.next).not.toHaveBeenCalled();
    expect(tree.first).not.toHaveBeenCalled();
    dialog.remove();
    press(handler, "j");
    expect(tree.next).toHaveBeenCalledWith(1);
    release();
  });

  it("chaos: defaultPrevented and a live g timer do not double-fire first", () => {
    vi.useFakeTimers();
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "g");
    const blocked = new KeyboardEvent("keydown", {
      key: "g",
      cancelable: true,
    });
    Object.defineProperty(blocked, "defaultPrevented", { value: true });
    handler(blocked);
    vi.advanceTimersByTime(600);
    press(handler, "j");
    expect(tree.first).not.toHaveBeenCalled();
    expect(tree.next).toHaveBeenCalledWith(1);
    release();
  });

  it("chaos: Tab while neither listing is focused is left to the browser", () => {
    const vault = target();
    const rail = {
      next: vi.fn(),
      previous: vi.fn(),
      first: vi.fn(),
      last: vi.fn(),
      enter: vi.fn(),
      parent: vi.fn(),
      activate: vi.fn(),
      focus: vi.fn(),
    };
    const stopVault = registerVaultKeymap(vault);
    const stopRail = registerRailKeymap(rail);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
    });
    handler(event);
    expect(event.defaultPrevented).toBe(false);
    expect(vault.focus).not.toHaveBeenCalled();
    expect(rail.focus).not.toHaveBeenCalled();
    stopVault();
    stopRail();
  });

  it("chaos: Ctrl-c is not stolen from the browser", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const event = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      cancelable: true,
    });
    handler(event);
    expect(event.defaultPrevented).toBe(false);
    expect(tree.page).not.toHaveBeenCalled();
    release();
  });
});
