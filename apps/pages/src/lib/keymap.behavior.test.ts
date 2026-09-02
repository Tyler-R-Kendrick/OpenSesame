/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type RailKeymapTarget,
  type VaultKeymapTarget,
  createKeymapHandler,
  registerRailKeymap,
  registerVaultKeymap,
} from "./keymap.js";

/**
 * Behaviour: a person can run the vault as a TUI — two listings, vim
 * motions, ranger climb/dive — without a second framework.
 */

function vault(): VaultKeymapTarget {
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

function rail(): RailKeymapTarget {
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
  };
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
      shiftKey:
        init.shiftKey ?? (key.length === 1 && key !== key.toLowerCase()),
      ...init,
    }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("listing keymap journey", () => {
  it("Given both listings, When the rail holds the keyboard and they press Tab, Then the vault listing is focused", () => {
    const items = vault();
    const nav = rail();
    const stopVault = registerVaultKeymap(items);
    const stopRail = registerRailKeymap(nav);
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
    expect(items.focus).toHaveBeenCalledOnce();
    expect(nav.focus).not.toHaveBeenCalled();
    stopVault();
    stopRail();
  });

  it("Given the vault listing, When they type 5G, Then the cursor goes to the fifth row", () => {
    const items = vault();
    const release = registerVaultKeymap(items);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "5");
    press(handler, "G");
    expect(items.toIndex).toHaveBeenCalledWith(4);
    expect(items.last).not.toHaveBeenCalled();
    release();
  });

  it("Given a g chord, When they press j instead of a section, Then j still moves", () => {
    const items = vault();
    const release = registerVaultKeymap(items);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "g");
    press(handler, "j");
    expect(items.next).toHaveBeenCalledWith(1);
    expect(items.first).not.toHaveBeenCalled();
    release();
  });

  it("Given they are typing a search, When they press j, Then the listing does not move", () => {
    const items = vault();
    const release = registerVaultKeymap(items);
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
    expect(items.next).not.toHaveBeenCalled();
    release();
  });
});
