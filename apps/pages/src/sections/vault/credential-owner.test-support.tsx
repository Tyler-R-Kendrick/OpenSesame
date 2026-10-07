import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import { switchCredentialPacksOn } from "@opensesame/app-core/lib/type-packs/credential-packs.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import {
  admitConnectorOwner,
  releaseConnectorOwner,
} from "../settings/connector-owner.test-support.js";
import { ItemEditor } from "./ItemEditor.js";

type CredentialOwnerFixture = {
  current: { items: VaultItem[]; folders: Folder[] };
};
export const vault: CredentialOwnerFixture = {
  current: { items: [], folders: [] },
};
export let saveItems = vi.fn<(items: readonly VaultItem[]) => Promise<void>>();
export let saveItem = vi.fn<(item: VaultItem) => Promise<void>>();

export async function open(path: string) {
  await vaultStore.replaceAll(vault.current.items, vault.current.folders);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vault/new/:kind?" element={<ItemEditor mode="new" />} />
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
        <Route path="*" element={<div>navigated away</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

export async function awaitSavedCredential() {
  await waitFor(() => expect(saveItem).toHaveBeenCalled());
  const result = saveItem.mock.results[0];
  const expected = saveItem.mock.calls[0]?.[0];
  if (result?.type !== "return" || !expected)
    throw new Error("Expected actual credential write.");
  await result.value;
  expect(
    vaultStore.getSnapshot().items.find((item) => item.id === expected.id),
  ).toMatchObject({
    kind: "credential",
    accountId: expected.kind === "credential" ? expected.accountId : null,
    method: expected.kind === "credential" ? expected.method : undefined,
  });
}

export async function awaitSavedAdoption() {
  await waitFor(() => expect(saveItems).toHaveBeenCalledTimes(1));
  const result = saveItems.mock.results[0];
  const expected = saveItems.mock.calls[0]?.[0];
  if (result?.type !== "return" || !expected)
    throw new Error("Expected actual atomic credential adoption.");
  await result.value;
  const raw = vaultStore.getSnapshot().rawItems;
  if (!raw) throw new Error("Expected admitted raw owner items.");
  for (const item of expected) {
    expect(raw.filter((entry) => entry.id === item.id)).toHaveLength(1);
    if (item.kind === "credential") {
      expect(raw.find((entry) => entry.id === item.id)).toMatchObject({
        accountId: item.accountId,
        method: item.method,
      });
    }
  }
}

export function installEditorHarness() {
  let revokeKinds = () => {};
  let revokePacks = () => {};
  beforeAll(() => {
    revokeKinds = registerLegacyItemKinds();
    revokePacks = switchCredentialPacksOn();
  });
  afterAll(() => {
    revokeKinds();
    revokePacks();
  });
  beforeEach(async () => {
    await admitConnectorOwner();
    vault.current = { items: [], folders: [] };
    saveItem = vi.spyOn(vaultStore, "saveItem");
    saveItems = vi.spyOn(vaultStore, "saveItems");
  });
  afterEach(async () => {
    cleanup();
    await releaseConnectorOwner();
    vi.restoreAllMocks();
  });
}
