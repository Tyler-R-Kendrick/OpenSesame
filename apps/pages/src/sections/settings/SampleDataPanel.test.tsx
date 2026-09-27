import type { Folder, VaultItem } from "@opensesame/vault-core";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };
const vault: VaultFixture = { current: { items: [], folders: [] } };
const applyImport = vi.hoisted(() => vi.fn());
const removeSample = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ applyImport, removeSample }),
});

import { SampleDataPanel } from "./SampleDataPanel.js";

describe("Settings › Vaults › Sample data", () => {
  beforeEach(() => {
    vault.current = { items: [createItem("login", "Real")], folders: [] };
    applyImport.mockResolvedValue(7);
    removeSample.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads badged sample items from one icon key in the panel head", async () => {
    render(<SampleDataPanel />);
    const key = screen.getByRole("button", { name: "Load sample data" });
    expect(key.className).toContain("icon-btn");
    expect(key.textContent).toBe("");
    expect(key.getAttribute("title")).toBe("Load sample data");
    expect(key.closest(".panel__head")).not.toBeNull();

    await userEvent.setup().click(key);

    expect(applyImport).toHaveBeenCalledTimes(1);
    const plan = applyImport.mock.calls[0]?.[0];
    expect(plan.items).toHaveLength(7);
    expect(
      plan.items.every((item: VaultItem) => item.sample === true),
    ).toBeTruthy();
    expect(removeSample).not.toHaveBeenCalled();
  });

  it("removes every sample item in one action, stating how many", async () => {
    vault.current = {
      items: [
        createItem("login", "Real"),
        { ...createItem("login", "Demo"), sample: true },
        { ...createItem("note", "Demo note"), sample: true },
      ],
      folders: [],
    };
    render(<SampleDataPanel />);
    expect(screen.getByRole("img", { name: "2 synthetic items" })).toBeTruthy();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Remove 2 sample items" }));

    expect(removeSample).toHaveBeenCalledTimes(1);
    expect(applyImport).not.toHaveBeenCalled();
  });

  it("marks a failed write beside the key, never in a box", async () => {
    applyImport.mockRejectedValue(new Error("disk full"));
    render(<SampleDataPanel />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Load sample data" }));
    expect(await screen.findByRole("img", { name: "disk full" })).toBeTruthy();
    expect(document.querySelector(".note")).toBeNull();
  });
});
