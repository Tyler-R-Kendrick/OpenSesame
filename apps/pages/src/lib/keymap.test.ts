/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type VaultKeymapTarget,
  createKeymapHandler,
  registerRailKeymap,
  registerVaultKeymap,
} from "./keymap.js";

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

function shifted(key: string): boolean {
  return key.length === 1 && key !== key.toLowerCase()
    ? true
    : key === "$" || key === "?";
}

function press(
  handler: (event: KeyboardEvent) => void,
  key: string,
  init: KeyboardEventInit = {},
) {
  handler(
    new KeyboardEvent("keydown", {
      key,
      cancelable: true,
      shiftKey: init.shiftKey ?? shifted(key),
      ...init,
    }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("application keymap", () => {
  it("drives the active vault tree and section jumps", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const navigate = vi.fn();
    const handler = createKeymapHandler({ navigate, showHelp: vi.fn() });

    for (const key of [
      "j",
      "k",
      "l",
      "h",
      "G",
      "Enter",
      "/",
      "y",
      "u",
      "e",
      "x",
      "n",
      ".",
      "s",
    ]) {
      press(handler, key);
    }
    press(handler, "g");
    press(handler, "g");
    press(handler, "g");
    press(handler, "a");

    expect(tree.next).toHaveBeenCalledOnce();
    expect(tree.previous).toHaveBeenCalledOnce();
    expect(tree.first).toHaveBeenCalledOnce();
    expect(tree.last).toHaveBeenCalledOnce();
    expect(tree.share).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/access");
    release();
  });

  it("ignores typing and modal ceremonies", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const input = document.createElement("input");
    input.addEventListener("keydown", handler);
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", bubbles: true }),
    );

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    handler(new KeyboardEvent("keydown", { key: "j" }));

    expect(tree.next).not.toHaveBeenCalled();
    release();
  });

  it("drives the rail when no vault tree is bound", () => {
    const rail = {
      next: vi.fn(),
      previous: vi.fn(),
      first: vi.fn(),
      last: vi.fn(),
      enter: vi.fn(),
      parent: vi.fn(),
      activate: vi.fn(),
    };
    const release = registerRailKeymap(rail);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    handler(
      new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }),
    );
    handler(new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true }));
    handler(new KeyboardEvent("keydown", { key: "j", cancelable: true }));
    expect(rail.next).toHaveBeenCalledTimes(2);
    expect(rail.previous).toHaveBeenCalledOnce();
    release();
  });

  it("arrows on the rail walk the rail even with a vault tree bound", () => {
    const vault = target();
    const rail = {
      next: vi.fn(),
      previous: vi.fn(),
      first: vi.fn(),
      last: vi.fn(),
      enter: vi.fn(),
      parent: vi.fn(),
      activate: vi.fn(),
    };
    const stopVault = registerVaultKeymap(vault);
    const stopRail = registerRailKeymap(rail);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const tree = document.createElement("nav");
    tree.className = "railtree";
    const row = document.createElement("a");
    tree.append(row);
    document.body.append(tree);
    window.addEventListener("keydown", handler);
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    window.removeEventListener("keydown", handler);
    expect(rail.next).toHaveBeenCalledOnce();
    expect(vault.next).not.toHaveBeenCalled();
    stopVault();
    stopRail();
  });

  it("applies a vim count to motions and treats 0 as first", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "5");
    press(handler, "j");
    press(handler, "1");
    press(handler, "0");
    press(handler, "k");
    press(handler, "0");
    press(handler, "5");
    press(handler, "G");
    press(handler, "G");
    expect(tree.next).toHaveBeenCalledWith(5);
    expect(tree.previous).toHaveBeenCalledWith(10);
    expect(tree.first).toHaveBeenCalledOnce();
    expect(tree.toIndex).toHaveBeenCalledWith(4);
    expect(tree.last).toHaveBeenCalledOnce();
    release();
  });

  it("pages with ctrl and Home/End aliases", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "d", { ctrlKey: true });
    press(handler, "u", { ctrlKey: true });
    press(handler, "f", { ctrlKey: true });
    press(handler, "b", { ctrlKey: true });
    press(handler, "PageDown");
    press(handler, "H");
    press(handler, "M");
    press(handler, "L");
    press(handler, "Home");
    press(handler, "$");
    press(handler, "Backspace");
    expect(tree.page).toHaveBeenCalledWith(1, "half");
    expect(tree.page).toHaveBeenCalledWith(-1, "half");
    expect(tree.page).toHaveBeenCalledWith(1, "full");
    expect(tree.page).toHaveBeenCalledWith(-1, "full");
    expect(tree.page).toHaveBeenCalledTimes(5);
    expect(tree.edge).toHaveBeenCalledWith("high");
    expect(tree.edge).toHaveBeenCalledWith("mid");
    expect(tree.edge).toHaveBeenCalledWith("low");
    expect(tree.first).toHaveBeenCalledOnce();
    expect(tree.last).toHaveBeenCalledOnce();
    expect(tree.parent).toHaveBeenCalledOnce();
    release();
  });

  it("Tab switches listings when a tree holds the keyboard", () => {
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
    const tree = document.createElement("nav");
    tree.className = "railtree";
    const row = document.createElement("a");
    tree.append(row);
    document.body.append(tree);
    window.addEventListener("keydown", handler);
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    window.removeEventListener("keydown", handler);
    expect(vault.focus).toHaveBeenCalledOnce();
    expect(rail.focus).not.toHaveBeenCalled();
    stopVault();
    stopRail();
  });

  it("treats a failed g chord as the second key", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "g");
    press(handler, "j");
    expect(tree.first).not.toHaveBeenCalled();
    expect(tree.next).toHaveBeenCalledWith(1);
    release();
  });

  it("repeats a page motion by the pending count", () => {
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "3");
    press(handler, "d", { ctrlKey: true });
    expect(tree.page).toHaveBeenCalledTimes(3);
    expect(tree.page).toHaveBeenCalledWith(1, "half");
    release();
  });

  it("drops a stale g chord so the next key is itself", () => {
    vi.useFakeTimers();
    const tree = target();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "g");
    vi.advanceTimersByTime(600);
    press(handler, "j");
    expect(tree.first).not.toHaveBeenCalled();
    expect(tree.next).toHaveBeenCalledWith(1);
    release();
    vi.useRealTimers();
  });
});
