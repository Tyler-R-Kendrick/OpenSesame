/** @vitest-environment jsdom */
/** The `?` sheet shows the keys in force, never the defaults beside the overrides. */
import {
  resetKeymap,
  saveKeymapData,
} from "@opensesame/app-core/lib/keymap/store.js";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KeymapSheet } from "./KeymapSheet.js";

afterEach(() => {
  cleanup();
  resetKeymap();
});

function rowFor(action: string): HTMLElement | null {
  const cell = screen
    .queryAllByRole("cell")
    .find((candidate) => candidate.textContent === action);
  return cell?.closest("tr") ?? null;
}

describe("the keyboard sheet", () => {
  it("draws the defaults as authored on an untouched keymap", () => {
    render(<KeymapSheet open close={() => {}} />);
    expect(within(rowFor("Move") as HTMLElement).getByText("j / k or arrows"));
  });

  it("moves j from Move to Edit instead of appending a second row", () => {
    saveKeymapData({ bindings: { j: "item.edit" }, macros: {} });
    render(<KeymapSheet open close={() => {}} />);
    expect(rowFor("Move")).toBeNull();
    expect(screen.queryByText("j / k or arrows")).toBeNull();
    const edit = screen
      .getAllByRole("cell")
      .filter((cell) => cell.textContent === "Edit");
    expect(edit).toHaveLength(1);
    expect(edit[0]?.closest("tr")?.textContent).toContain("j / e");
  });

  it("follows a rebinding made while the sheet is open", () => {
    render(<KeymapSheet open close={() => {}} />);
    expect(rowFor("Move")).not.toBeNull();
    act(() => {
      saveKeymapData({ bindings: { j: "nop", k: "nop" }, macros: {} });
    });
    expect(screen.queryByText("j / k or arrows")).toBeNull();
    expect(
      within(rowFor("Next row") as HTMLElement).getByText("↓"),
    ).toBeTruthy();
  });
});
