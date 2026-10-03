/** @vitest-environment jsdom */
/** Macro steps keep their place; a macro's trigger is read, not badged. */
import {
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
import { afterEach, describe, expect, it } from "vitest";
import { renderPanels, row } from "./keybindings-test-kit.js";

afterEach(() => {
  cleanup();
  resetKeymap();
});

function openEditor(steps: number) {
  renderPanels();
  fireEvent.click(screen.getByRole("button", { name: "New macro" }));
  const editor = screen.getByRole("form", { name: "New macro" });
  for (let at = 0; at < steps; at += 1) {
    fireEvent.click(within(editor).getByRole("button", { name: "Add a step" }));
  }
  const choose = (step: number, value: string) =>
    fireEvent.change(
      within(editor).getByRole("combobox", {
        name: `Command for step ${step}`,
      }),
      { target: { value } },
    );
  choose(1, "listing.first");
  choose(2, "listing.next");
  choose(3, "listing.previous");
  return editor;
}

function commandOf(editor: HTMLElement, step: number): string {
  return within(editor).getByRole<HTMLSelectElement>("combobox", {
    name: `Command for step ${step}`,
  }).value;
}

function moveButton(editor: HTMLElement, name: string): HTMLElement {
  const button = within(editor).getByRole("button", { name });
  act(() => button.focus());
  return button;
}

describe("Macro steps after a move", () => {
  it("keeps focus on the same key of the step in its new place", () => {
    const editor = openEditor(3);
    fireEvent.click(moveButton(editor, "Move step 1 down"));
    expect(commandOf(editor, 2)).toBe("listing.first");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Move step 2 down",
    );
    fireEvent.click(moveButton(editor, "Move step 2 up"));
    expect(commandOf(editor, 1)).toBe("listing.first");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Move step 1 down",
    );
  });

  it("falls to the other direction where the step reached an end", () => {
    const editor = openEditor(3);
    fireEvent.click(moveButton(editor, "Move step 2 down"));
    expect(commandOf(editor, 3)).toBe("listing.next");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Move step 3 up",
    );
  });

  it("does not take focus the person already moved", () => {
    const editor = openEditor(3);
    const name = within(editor).getByLabelText("Name");
    const down = within(editor).getByRole("button", {
      name: "Move step 1 down",
    });
    act(() => name.focus());
    fireEvent.click(down);
    expect(document.activeElement).toBe(name);
  });
});

describe("A macro's trigger", () => {
  it("is an icon that says when, beside the event's name as text", () => {
    saveKeymapData({
      bindings: {},
      macros: {
        triage: { on: "unlock", steps: ["listing.next"] },
      },
    });
    renderPanels();
    const trigger = within(row("@triage")).getByRole("img", {
      name: "Runs when the vault unlocks",
    });
    expect(trigger.textContent).toBe("unlock");
    expect(trigger.querySelector("svg")).toBeTruthy();
    expect(row("@triage").textContent).not.toMatch(/\bon unlock\b/);
  });
});

describe("A step whose command is no longer offered", () => {
  it("keeps showing the command it will save, not the first choice", () => {
    // A jump to a section whose capability is absent today: valid to keep,
    // but not among the commands a step may be changed to.
    expect(
      saveKeymapData({
        bindings: {},
        macros: { away: { steps: ["section.gone-today"] } },
      }).ok,
    ).toBe(true);
    renderPanels();
    fireEvent.click(screen.getByRole("button", { name: "Edit @away" }));
    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Command for step 1",
    });
    expect(select.value).toBe("section.gone-today");
    expect(select.selectedOptions[0]?.textContent).toBe("section.gone-today");
  });
});
