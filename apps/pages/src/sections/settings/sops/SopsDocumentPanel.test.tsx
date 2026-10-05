/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SopsDocumentPanel } from "./SopsDocumentPanel.js";

afterEach(cleanup);

describe("SopsDocumentPanel", () => {
  it("draws one key, named for what it opens, and no sheet until it is pressed", () => {
    render(<SopsDocumentPanel />);
    expect(screen.getByRole("button", { name: "SOPS document" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "SOPS document" })).toBeNull();
  });

  it("opens the SOPS document sheet from its key", async () => {
    render(<SopsDocumentPanel />);
    await userEvent.click(
      screen.getByRole("button", { name: "SOPS document" }),
    );
    expect(screen.getByRole("dialog", { name: "SOPS document" })).toBeTruthy();
  });
});
