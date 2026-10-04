/** @vitest-environment jsdom */
/** A key is drawn only while it acts: no disabled reset, move, add or edit (ADR 0158). */
import { MACRO_LIMITS } from "@opensesame/app-core/lib/keymap/config.js";
import { resetKeymap } from "@opensesame/app-core/lib/keymap/store.js";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderPanels } from "./keybindings-test-kit.js";

afterEach(() => {
  cleanup();
  resetKeymap();
});

const key = (name: string | RegExp) => screen.queryByRole("button", { name });

function openNew() {
  renderPanels();
  fireEvent.click(screen.getByRole("button", { name: "New macro" }));
  return screen.getByRole("form", { name: "New macro" });
}

describe("Keybindings keys that act", () => {
  it("draws no reset while nothing is changed, and no key anywhere is disabled", () => {
    renderPanels();
    expect(key("Reset every key and macro")).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect(button, button.getAttribute("aria-label") ?? "").toHaveProperty(
        "disabled",
        false,
      );
    }
  });

  it("draws the reset once something is changed", () => {
    renderPanels();
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Single-character keys run commands",
      }),
    );
    expect(key("Reset every key and macro")).toHaveProperty("disabled", false);
  });

  it("moves focus into the editor that replaces New macro, and draws no second New macro", () => {
    const editor = openNew();
    expect(key("New macro")).toBeNull();
    expect(document.activeElement).toBe(within(editor).getByLabelText("Name"));
  });

  it("draws no move up for the first step and no move down for the last", () => {
    const editor = openNew();
    fireEvent.click(within(editor).getByRole("button", { name: "Add a step" }));
    expect(
      within(editor).queryByRole("button", { name: "Move step 1 up" }),
    ).toBeNull();
    expect(
      within(editor).queryByRole("button", { name: "Move step 1 down" }),
    ).toBeNull();
    fireEvent.click(within(editor).getByRole("button", { name: "Add a step" }));
    expect(
      within(editor).queryByRole("button", { name: "Move step 1 up" }),
    ).toBeNull();
    expect(
      within(editor).getByRole("button", { name: "Move step 1 down" }),
    ).toBeTruthy();
    expect(
      within(editor).getByRole("button", { name: "Move step 2 up" }),
    ).toBeTruthy();
    expect(
      within(editor).queryByRole("button", { name: "Move step 2 down" }),
    ).toBeNull();
  });

  it("draws no add or record key at the step limit, and keeps focus in the editor", () => {
    const editor = openNew();
    for (let at = 0; at < MACRO_LIMITS.steps - 1; at += 1) {
      fireEvent.click(
        within(editor).getByRole("button", { name: "Add a step" }),
      );
    }
    const add = within(editor).getByRole("button", { name: "Add a step" });
    add.focus();
    fireEvent.click(add);
    expect(
      within(editor).queryByRole("button", { name: "Add a step" }),
    ).toBeNull();
    expect(
      within(editor).queryByRole("button", {
        name: "Record steps by pressing keys",
      }),
    ).toBeNull();
    expect(editor.contains(document.activeElement)).toBe(true);
    // Removing a step brings the key back and focus follows it.
    fireEvent.click(
      within(editor).getByRole("button", { name: "Remove step 1" }),
    );
    expect(within(editor).getByRole("button", { name: "Add a step" })).toBe(
      document.activeElement,
    );
  });
});
