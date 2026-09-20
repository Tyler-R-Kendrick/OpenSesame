/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SupportProvider } from "../session.js";
import {
  SupportLauncher,
  SupportSlot,
  SupportSlotProvider,
} from "./SupportLauncher.js";

afterEach(() => {
  cleanup();
});

describe("support statusline seating", () => {
  it("seats the mark in the statusline and leaves asking to the panel", () => {
    render(
      <MemoryRouter>
        <SupportProvider>
          <SupportSlotProvider>
            <footer className="statusline">
              <SupportSlot />
            </footer>
            <SupportLauncher />
          </SupportSlotProvider>
        </SupportProvider>
      </MemoryRouter>,
    );
    const chrome = screen.getByRole("button", { name: "Support" });
    expect(chrome.closest(".statusline")).not.toBeNull();
    expect(chrome.className).toContain("support-launch--chrome");
    expect(screen.getAllByRole("button", { name: "Support" })).toHaveLength(1);
    // Support ask stays in the sheet. The statusline omnibox is CommandBar.
    expect(screen.queryByLabelText("Ask about this screen")).toBeNull();
    expect(screen.queryByPlaceholderText("Questions only")).toBeNull();
  });

  it("falls back to the overlay when the shell has no seat", () => {
    render(
      <MemoryRouter>
        <SupportProvider>
          <SupportSlotProvider>
            <SupportLauncher />
          </SupportSlotProvider>
        </SupportProvider>
      </MemoryRouter>,
    );
    const mark = screen.getByRole("button", { name: "Support" });
    expect(mark.closest(".statusline")).toBeNull();
    expect(mark.className).not.toContain("support-launch--chrome");
  });
});
