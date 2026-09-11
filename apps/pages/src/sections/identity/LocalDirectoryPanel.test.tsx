/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as directory from "../../lib/local-directory.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { LocalDirectoryPanel } from "./LocalDirectoryPanel.js";

const originalVault = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVaultStore: () => ({ activeTomb: () => "tomb" }),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.assign(vaultHooksSeams, originalVault);
});

it("keeps new and reload as named icon keys, not text buttons", async () => {
  vi.spyOn(directory, "ensureOwnerPerson").mockResolvedValue({
    version: 2,
    revision: 1,
    entries: [],
    memberships: [],
  });
  render(<LocalDirectoryPanel kind="person" />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "New person" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  const bar = screen.getByRole("group", { name: "People commands" });
  for (const name of ["New person", "Reload directory"]) {
    const control = screen.getByRole("button", { name });
    expect(control.textContent).toBe("");
    expect(control.querySelector("svg")).not.toBeNull();
    expect(control.getAttribute("title")).toBe(name);
    expect(control.className).toContain("icon-btn--sm");
    expect(bar.contains(control)).toBe(true);
  }
});
