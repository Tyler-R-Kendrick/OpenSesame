/** @vitest-environment jsdom */
import {
  listResetEmails,
  resetPasswordResetMailForTest,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PasswordResetMailPanel } from "./panel.js";

afterEach(() => {
  cleanup();
  resetPasswordResetMailForTest();
});

describe("PasswordResetMailPanel", () => {
  it("adds an address and removes it", () => {
    render(<PasswordResetMailPanel />);
    const input = screen.getByRole("textbox", { name: "Reset email" });
    fireEvent.change(input, { target: { value: "  A@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Add reset email" }));
    expect(screen.getByText("a@example.com")).toBeTruthy();
    expect(listResetEmails().map((email) => email.address)).toEqual([
      "a@example.com",
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove a@example.com" }),
    );
    expect(screen.queryByText("a@example.com")).toBeNull();
    expect(listResetEmails()).toEqual([]);
  });

  it("keeps a shapeless address in the field", () => {
    render(<PasswordResetMailPanel />);
    const input = screen.getByRole("textbox", { name: "Reset email" });
    fireEvent.change(input, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reset email" }));
    expect(input).toHaveProperty("value", "not-an-email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(listResetEmails()).toEqual([]);
  });
});
