import { screen, within } from "@testing-library/react";
import { expect } from "vitest";

/** The same commands must survive every list state. */
export function expectVaultCommands() {
  const bar = screen.getByRole("group", { name: "Vault commands" });
  const commands = within(bar);
  const control = commands.getByRole("link", { name: "New item" });
  expect(control.textContent).toBe("");
  expect(control.querySelector("svg")).not.toBeNull();
  expect(control.getAttribute("title")).toBeTruthy();
  expect(commands.queryByRole("button", { name: "Import items" })).toBeNull();
  expect(commands.queryByRole("link", { name: "Export items" })).toBeNull();
  expect(bar.closest(".vtree")?.firstElementChild?.contains(bar)).toBe(true);
}
