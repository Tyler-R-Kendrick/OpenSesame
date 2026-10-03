/** @vitest-environment jsdom */
/** Where focus lands after a reset, what a locked row draws, what is announced. */
import {
  loadKeymap,
  resetKeymap,
  saveKeymapData,
} from "@opensesame/app-core/lib/keymap/store.js";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPanels, row } from "./keybindings-test-kit.js";

afterEach(() => {
  cleanup();
  resetKeymap();
});

function changed() {
  saveKeymapData({ bindings: { w: "listing.next" }, macros: {} });
}

function focused(name: string | RegExp): HTMLElement {
  const button = screen.getByRole("button", { name });
  act(() => button.focus());
  return button;
}

function showOnly(filter: string) {
  fireEvent.change(screen.getByRole("combobox", { name: "Show" }), {
    target: { value: filter },
  });
}

describe("Focus after a reset", () => {
  it("lands on the row's + when the row is still drawn", () => {
    changed();
    renderPanels();
    fireEvent.click(focused("Reset Next row to its default keys"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Add a key for Next row",
    );
    expect(row("Next row").hasAttribute("data-changed")).toBe(false);
  });

  it("lands on the Show choice when the filter drops the row", () => {
    changed();
    renderPanels();
    showOnly("changed");
    fireEvent.click(focused("Reset Next row to its default keys"));
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "Show" }),
    );
  });

  it("lands on the Show choice after Reset all", () => {
    changed();
    renderPanels();
    const all = focused("Reset every key and macro");
    fireEvent.click(all);
    fireEvent.click(all);
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "Show" }),
    );
  });

  it("says so, and keeps the keymap, when storage will not take Reset all", () => {
    changed();
    renderPanels();
    const remove = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    const all = focused("Reset every key and macro");
    fireEvent.click(all);
    fireEvent.click(all);
    remove.mockRestore();
    set.mockRestore();
    expect(
      screen.getByRole("img", {
        name: "The keymap could not be reset on this device.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "The keymap could not be reset on this device.",
    );
    expect(loadKeymap().bindings).toEqual({ w: "listing.next" });
    expect(row("Next row").hasAttribute("data-changed")).toBe(true);
  });

  it("drops the refusal once the keymap changes, so a later edit leaves none on screen", () => {
    changed();
    renderPanels();
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    const all = focused("Reset every key and macro");
    fireEvent.click(all);
    fireEvent.click(all);
    set.mockRestore();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(focused("Reset Next row to its default keys"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("img", {
        name: "The keymap could not be reset on this device.",
      }),
    ).toBeNull();
  });

  it("does not take focus the person already moved", () => {
    changed();
    renderPanels();
    const reset = screen.getByRole("button", {
      name: "Reset Next row to its default keys",
    });
    const find = screen.getByRole("searchbox", { name: "Find a command" });
    act(() => find.focus());
    fireEvent.click(reset);
    expect(document.activeElement).toBe(find);
  });
});

describe("A locked command whose key another command took", () => {
  it("draws the key struck, and offers nothing", () => {
    saveKeymapData({ bindings: { x: "listing.next" }, macros: {} });
    renderPanels();
    const trash = row("Move to trash");
    const key = within(trash).getByRole("img", {
      name: "x — taken by another command",
    });
    expect(key.className).toContain("keycap-btn--removed");
    expect(within(trash).queryByRole("button", { name: /x/ })).toBeNull();
  });

  it("draws an untouched key as bound", () => {
    renderPanels();
    const key = within(row("Move to trash")).getByRole("img", { name: "x" });
    expect(key.className).not.toContain("keycap-btn--removed");
  });
});

describe("The command count is announced once per change", () => {
  it("differs for a repeated count so a reader says it again", () => {
    renderPanels();
    const find = screen.getByRole("searchbox", { name: "Find a command" });
    const count = () => document.querySelector(".kb-count")?.textContent ?? "";
    fireEvent.change(find, { target: { value: "zzz" } });
    const first = count();
    fireEvent.change(find, { target: { value: "zzy" } });
    const second = count();
    expect(first.replace(/\u200B/g, "")).toBe("0 commands");
    expect(second.replace(/\u200B/g, "")).toBe("0 commands");
    expect(second).not.toBe(first);
  });
});
