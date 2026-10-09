/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { LocalAuthorityTemplates } from "./LocalAuthorityTemplates.js";
import { renderAccess as render } from "./workspace-test-support.js";

afterEach(() => {
  cleanup();
});

it("lists audience templates and shows honest support statuses", async () => {
  const user = userEvent.setup();
  render(
    <LocalAuthorityTemplates />,
    "/access?view=sessions#local-authority-templates",
  );
  expect(
    screen.getByRole("tree", { name: "Audience templates items" }),
  ).toBeTruthy();
  await user.click(screen.getByRole("treeitem", { name: /raid/i }));
  // Choosing a template is the whole action: no second button re-selects it.
  expect(screen.queryByRole("button", { name: /defaults/i })).toBeNull();
  expect(screen.getByRole("heading", { name: /raid/i })).toBeTruthy();
  // Support is a status glyph whose name is the sentence, not a word pill.
  expect(
    screen.getAllByRole("img", { name: /unsupported|configuration required/i })
      .length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText(/\benforced\b/i)).toBeNull();
});

it("includes family, contractor, and data-only extended audiences", () => {
  render(
    <LocalAuthorityTemplates />,
    "/access?view=sessions#local-authority-templates",
  );
  expect(screen.getAllByRole("treeitem").length).toBeGreaterThanOrEqual(8);
});
