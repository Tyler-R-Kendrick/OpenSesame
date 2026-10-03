/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchMediaFor } from "../host/fake-media-query.js";
import { SupportProvider } from "../tutorial/session.js";
import { touchTips } from "./EmptyTip.js";
import { MoreMenu } from "./MoreMenu.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", matchMediaFor(coarse));
}

function menuRows(): string[] {
  render(
    <MemoryRouter>
      <SupportProvider>
        <MoreMenu />
      </SupportProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^More/ }));
  return screen
    .getAllByRole("button")
    .map((row) => row.querySelector(".more__name")?.textContent ?? "")
    .filter((name) => name !== "");
}

describe("the ⋯ menu's rows", () => {
  it("lists Gestures under a finger, and Help is the other row", () => {
    pointer(true);
    const rows = menuRows();
    expect(rows).toContain("Gestures");
    expect(rows).toContain("Help");
    expect(rows).not.toContain("Keyboard shortcuts");
  });

  it("is the row the keymap tip's touch twin sends a finger to", () => {
    // The twin must name a row the menu really draws, and not the Help row,
    // which opens Support rather than the list of gestures.
    pointer(true);
    const rows = menuRows();
    const named = rows.filter((name) => touchTips.keymap.startsWith(name));
    expect(named).toEqual(["Gestures"]);
    expect(touchTips.keymap).not.toMatch(/^Help\b/);
  });
});
