import type { Folder, VaultItem } from "@opensesame/vault-core";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type VaultState = {
  items: VaultItem[];
  folders: Folder[];
  status: string;
  guest: boolean;
};
type VaultFixture = { current: VaultState };
const vault: VaultFixture = {
  current: { items: [], folders: [], status: "unlocked", guest: false },
};

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, { useVault: () => vault.current });

import { downloadSeams } from "../../screens/capabilities/download.js";
import { StoreManifestPanel } from "./StoreManifestPanel.js";

const saved: { name: string; text: string; type: string }[] = [];
const originalSave = downloadSeams.save;

describe("Settings › Vaults › Sealed store", () => {
  beforeEach(() => {
    saved.length = 0;
    downloadSeams.save = (name, text, type = "") => {
      saved.push({ name, text, type });
    };
    const dev: Folder = { id: "fld", name: "Dev", createdAt: "2026-01-01" };
    const token = createItem("secret", "Token");
    token.value = "t0k3n"; // gitleaks:allow -- fixture
    vault.current = {
      items: [{ ...token, folderId: dev.id }],
      folders: [dev],
      status: "unlocked",
      guest: false,
    };
  });

  afterEach(() => {
    cleanup();
    downloadSeams.save = originalSave;
  });

  it("saves the pass seal manifest from its sheet, never from the key alone", async () => {
    const user = userEvent.setup();
    render(<StoreManifestPanel />);
    const key = screen.getByRole("button", {
      name: "Save store path manifest",
    });
    expect(key.className).toContain("icon-btn");
    expect(key.textContent).toBe("");
    // A row of the panel, with its count; the ceremony's card is not on the page.
    expect(key.closest(".sw")).not.toBeNull();
    expect(screen.getByText("1 entry")).toBeTruthy();
    expect(
      screen.queryByText("opensesame pass seal <file> --shred"),
    ).toBeNull();

    // The key opens a sheet that says what the file holds; nothing is saved.
    await user.click(key);
    expect(saved).toHaveLength(0);
    const sheet = screen.getByRole("dialog", {
      name: "Save store path manifest",
    });
    expect(sheet.textContent).toContain(
      "every value in plain text, private keys included",
    );

    await user.click(screen.getByRole("button", { name: /Save manifest/ }));

    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toMatch(
      /^opensesame-store-manifest-\d{4}-\d{2}-\d{2}\.json$/,
    );
    expect(saved[0]?.type).toBe("application/json");
    expect(JSON.parse(saved[0]?.text ?? "")).toEqual([
      {
        path: "Dev/Token",
        secret: "t0k3n",
        trailer: '{"kind":"secret","v":2}\n',
      },
    ]);
    expect(
      screen.getByRole("img", { name: `Saved ${saved[0]?.name}` }),
    ).toBeTruthy();
  });

  it.each([
    ["a guest vault", { guest: true }, "A guest vault is not exported"],
    ["a locked vault", { status: "locked" }, "Unlock to export"],
  ])("refuses %s as the encrypted Export does", async (_, state, reason) => {
    vault.current = { ...vault.current, ...state };
    const user = userEvent.setup();
    render(<StoreManifestPanel />);
    await user.click(
      screen.getByRole("button", { name: "Save store path manifest" }),
    );
    expect(screen.getByRole("img", { name: reason })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save manifest/ })).toBeNull();
    expect(saved).toHaveLength(0);
  });

  it("has nothing to save from a vault with no items", () => {
    vault.current = {
      items: [],
      folders: [],
      status: "unlocked",
      guest: false,
    };
    render(<StoreManifestPanel />);
    expect(
      screen.getByRole("button", { name: "Save store path manifest" }),
    ).toHaveProperty("disabled", true);
  });
});
