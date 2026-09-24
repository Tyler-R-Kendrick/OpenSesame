/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { LocalAuthorityTemplates } from "./LocalAuthorityTemplates.js";

afterEach(() => {
  cleanup();
});

it("lists audience templates and shows honest support statuses", async () => {
  const user = userEvent.setup();
  render(<LocalAuthorityTemplates />);
  expect(
    screen.getByRole("heading", { name: "Audience templates" }),
  ).toBeTruthy();
  const select = screen.getByLabelText("Template");
  await user.selectOptions(select, "raid");
  // Choosing a template is the whole action: no second button re-selects it.
  expect(screen.queryByRole("button", { name: /defaults/i })).toBeNull();
  expect((select as HTMLSelectElement).value).toBe("raid");
  expect(
    screen.getAllByText(/unsupported|configuration required/i).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText(/\benforced\b/i)).toBeNull();
});

it("includes family, contractor, and data-only extended audiences", () => {
  render(<LocalAuthorityTemplates />);
  const select = screen.getByLabelText("Template");
  const values = [...select.querySelectorAll("option")].map(
    (option) => option.value,
  );
  expect(values).toEqual(
    expect.arrayContaining([
      "family",
      "contractor",
      "raid",
      "guest",
      "classroom",
      "incident",
      "ci",
      "research-workshop",
    ]),
  );
});
