/** @vitest-environment jsdom */
import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import {
  type VaultItem,
  createItem,
  manualPassword,
  splitAccount,
} from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { SettingsDangerPanel } from "./SettingsDangerPanel.js";

const vault = vi.hoisted(() => {
  const prefs: VaultPrefs = {
    theme: "system",
    autoLockMinutes: 0,
    clipboardClearSeconds: 30,
    lockOnHide: false,
    signOutOnLock: false,
  };
  return {
    prefs,
    items: [] as VaultItem[],
    folders: [],
    header: { wrap: {}, kdf: { iterations: 600_000 } },
  };
});

const store = vi.hoisted(() => ({
  destroy: vi.fn(),
  emptyTrash: vi.fn(),
  purgeItem: vi.fn(),
  restoreItem: vi.fn(),
}));

const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault,
  useVaultStore: () => store,
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

afterEach(() => {
  cleanup();
  vault.items = [];
});

describe("SettingsDangerPanel", () => {
  it("counts a trashed account and its bound password as one item", () => {
    const at = "2026-09-01T00:00:00.000Z";
    const draft = {
      ...createItem("account", "Billing"),
      id: "acct",
      methods: [manualPassword("acct:p")],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    vault.items = splitAccount([], draft, at).map((item) =>
      item.deletedAt === null ? { ...item, deletedAt: at } : item,
    );
    render(<SettingsDangerPanel />);
    expect(screen.getByText(/1 item in the trash/)).toBeTruthy();
    expect(screen.getByText(/· 1 item/)).toBeTruthy();
    expect(screen.getByText("Billing")).toBeTruthy();
    expect(screen.queryByText(/Password/)).toBeNull();
  });
});
