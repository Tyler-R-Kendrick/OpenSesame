import { screen, within } from "@testing-library/react";
import { expect } from "vitest";

/** The same commands must survive every list state. */
export function expectVaultCommands() {
  const bar = screen.getByRole("group", { name: "Vault commands" });
  const commands = within(bar);
  for (const [role, name] of [
    ["link", "New item"],
    ["button", "Import items"],
    ["link", "Export items"],
  ]) {
    const control = commands.getByRole(role, { name });
    expect(control.textContent).toBe("");
    expect(control.querySelector("svg")).not.toBeNull();
    expect(control.getAttribute("title")).toBeTruthy();
  }
  expect(
    commands.getByRole("link", { name: "Export items" }).getAttribute("href"),
  ).toBe("/settings/data#export");
  expect(bar.closest(".vtree")?.firstElementChild?.contains(bar)).toBe(true);
}
