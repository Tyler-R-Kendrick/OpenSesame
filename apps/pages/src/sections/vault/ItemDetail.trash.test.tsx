/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { planeHookSeams } from "../../bindings/planes.js";

import type { Folder, VaultItem } from "@opensesame/vault-core";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], folders: [] } }),
);
const store = vi.hoisted(() => ({
  toggleFavorite: vi.fn<(id: string) => Promise<void>>(),
  saveItem: vi.fn<(item: VaultItem) => Promise<void>>(),
  trashItem: vi.fn<(id: string) => Promise<void>>(),
  restoreItem: vi.fn<(id: string) => Promise<void>>(),
  purgeItem: vi.fn<(id: string) => Promise<void>>(),
}));
const copySecret = vi.hoisted(() => vi.fn());
const planes = vi.hoisted(() => ({
  value: { host: "live", identity: "connected" },
}));
const listConnections = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";

const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => copySecret,
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

Object.assign(planeHookSeams, { usePlaneStatus: () => planes.value });
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";

const originalConnectionSeams = { ...connectionSeams };
Object.assign(connectionSeams, { listConnections });
afterAll(() => Object.assign(connectionSeams, originalConnectionSeams));

import { ItemDetail } from "./ItemDetail.js";
import { makeAccount } from "./account.test-support.js";

function renderAt(itemId: string) {
  return render(
    <MemoryRouter initialEntries={[`/vault/${itemId}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vault.current = { items: [], folders: [] };
  planes.value = { host: "live", identity: "connected" };
  copySecret.mockResolvedValue("copied");
  listConnections.mockResolvedValue([]);
  store.saveItem.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("moves an item to trash after a second press, and keep cancels it", async () => {
  vault.current = { items: [makeAccount({ id: "itm_login" })], folders: [] };
  renderAt("itm_login");
  await userEvent.click(screen.getByRole("button", { name: /Move to trash/i }));
  expect(store.trashItem).not.toHaveBeenCalled();
  expect(screen.getByText(/Press the trash key again to confirm/)).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: /Keep this item/i }),
  );
  expect(store.trashItem).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: /Move to trash/i }));
  await userEvent.click(
    screen.getByRole("button", { name: /Really move to trash/i }),
  );
  expect(store.trashItem).toHaveBeenCalledWith("itm_login");
});
