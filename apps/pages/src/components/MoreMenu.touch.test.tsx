/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTheme, setTheme } from "../lib/theme.js";
import { matchMediaFor } from "../lib/use-narrow.test-fake.js";
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

describe("the More key as a tutorial target", () => {
  it("is where the connections' state is read, before and after it opens", () => {
    pointer(true);
    render(
      <MemoryRouter>
        <SupportProvider>
          <MoreMenu />
        </SupportProvider>
      </MemoryRouter>,
    );
    const key = screen.getByRole("button", { name: /^More/ });
    expect(key.getAttribute("data-guide-targets")).toContain(
      "shell.connectivity",
    );
    fireEvent.click(key);
    // The rows carry the id too; the key is still the first one pointed at.
    expect(
      document.querySelectorAll('[data-guide-targets~="shell.connectivity"]')
        .length,
    ).toBe(2);
  });
});

describe("appearance in the mobile menu", () => {
  it("selects Day, Night and System without closing the context menu", () => {
    pointer(true);
    menuRows();
    for (const [name, theme] of [
      ["Day", "light"],
      ["Night", "dark"],
      ["System", "system"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(loadTheme()).toBe(theme);
      expect(document.documentElement.getAttribute("data-theme")).toBe(
        theme === "system" ? null : theme,
      );
      expect(screen.getByRole("button", { name, pressed: true })).toBeTruthy();
      expect(screen.getByRole("dialog", { name: "More" })).toBeTruthy();
    }
    setTheme("system");
  });
});
