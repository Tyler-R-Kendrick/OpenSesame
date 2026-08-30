/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type VaultKeymapTarget,
  createKeymapHandler,
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

afterEach(() => {
  document.body.replaceChildren();
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
      handler(new KeyboardEvent("keydown", { key, cancelable: true }));
    }
    handler(new KeyboardEvent("keydown", { key: "g", cancelable: true }));
    handler(new KeyboardEvent("keydown", { key: "g", cancelable: true }));
    handler(new KeyboardEvent("keydown", { key: "g", cancelable: true }));
    handler(new KeyboardEvent("keydown", { key: "a", cancelable: true }));

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
});
