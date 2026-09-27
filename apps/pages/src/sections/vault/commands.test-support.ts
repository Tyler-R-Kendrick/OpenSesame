import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { screen, within } from "@testing-library/react";
import { expect } from "vitest";
import { IMPORT_COMMAND } from "../../modules/vault.interop-formats/runtime.js";

/**
 * Import is the `vault.interop-formats` capability's key. A suite that
 * checks the path strip imports this file, so the key is registered here
 * exactly as that capability's runtime registers it, for the whole suite.
 */
registerContributionForTest("vault-command", IMPORT_COMMAND);

/**
 * The same commands must survive every list state: New item, Import (the
 * `vault.interop-formats` contribution) and Export, each an icon key with a
 * name and a tooltip, in the path strip at the top of the pane.
 */
export function expectVaultCommands() {
  const bar = screen.getByRole("group", { name: "Vault commands" });
  const commands = within(bar);
  for (const [role, name] of [
    ["link", "New item"],
    ["button", "Import items"],
    ["button", "Export items"],
  ]) {
    const control = commands.getByRole(role, { name });
    expect(control.textContent).toBe("");
    expect(control.querySelector("svg")).not.toBeNull();
    expect(control.getAttribute("title")).toBeTruthy();
  }
  // New, import, export — in that order (DESIGN.md: "+, import, export").
  const order = [
    commands.getByRole("link", { name: "New item" }),
    commands.getByRole("button", { name: "Import items" }),
    commands.getByRole("button", { name: "Export items" }),
  ];
  for (let index = 1; index < order.length; index += 1) {
    const before = order[index - 1];
    const after = order[index];
    if (!before || !after) throw new Error("missing vault command");
    expect(
      before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  expect(bar.closest(".vtree")?.firstElementChild?.contains(bar)).toBe(true);
}
