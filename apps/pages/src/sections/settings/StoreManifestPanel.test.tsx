import type { Folder, VaultItem } from "@opensesame/vault-core";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };
const vault: VaultFixture = { current: { items: [], folders: [] } };

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
      items: [
        { ...token, folderId: dev.id },
        { ...createItem("login", "Demo"), sample: true },
      ],
      folders: [dev],
    };
  });

  afterEach(() => {
    cleanup();
    downloadSeams.save = originalSave;
  });

  it("saves the pass seal manifest from one icon key, sample data left out", async () => {
    render(<StoreManifestPanel />);
    const key = screen.getByRole("button", {
      name: "Save store path manifest",
    });
    expect(key.className).toContain("icon-btn");
    expect(key.textContent).toBe("");
    expect(key.closest(".panel__head")).not.toBeNull();
    expect(
      screen.getByText("opensesame pass seal <file> --shred"),
    ).toBeTruthy();

    await userEvent.setup().click(key);

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

  it("has nothing to save from a vault of sample data alone", () => {
    vault.current = {
      items: [{ ...createItem("login", "Demo"), sample: true }],
      folders: [],
    };
    render(<StoreManifestPanel />);
    expect(
      screen.getByRole("button", { name: "Save store path manifest" }),
    ).toHaveProperty("disabled", true);
  });
});
