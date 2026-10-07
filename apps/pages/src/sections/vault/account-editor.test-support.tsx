import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import { switchCredentialPacksOn } from "@opensesame/app-core/lib/type-packs/credential-packs.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type AccountItem,
  type Folder,
  type PasswordMethod,
  type VaultItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

export type VaultFixture = {
  current: { items: VaultItem[]; folders: Folder[] };
};

export const vault: VaultFixture = { current: { items: [], folders: [] } };
export const saveItem = vi.fn<(item: VaultItem) => Promise<void>>();
export const saveItems =
  vi.fn<(items: readonly VaultItem[]) => Promise<void>>();

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({
    saveItem,
    saveItems,
    pinContinuation: vaultStore.pinContinuation,
  }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

import { ItemEditor } from "./ItemEditor.js";

export function open(path: string) {
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

export function input(label: string | RegExp): HTMLInputElement {
  const element = screen.getByLabelText(label, { selector: "input" });
  if (!(element instanceof HTMLInputElement))
    throw new Error(`expected an input for ${String(label)}`);
  return element;
}

export function block(name: string) {
  return within(screen.getByRole("group", { name: `${name} method` }));
}

/** Open a password line's options, closed until its key is pressed. */
export async function showOptions(group: ReturnType<typeof block>) {
  const key = group.getByRole("button", { name: "Password options" });
  if (key.getAttribute("aria-expanded") !== "true") await userEvent.click(key);
}

export function saved(): AccountItem {
  const item = saveItem.mock.calls[0]?.[0];
  if (item?.kind !== "account") throw new Error("expected a saved account");
  return item;
}

export function passwordOf(item: AccountItem): PasswordMethod {
  const method = passwordMethod(item);
  if (!method) throw new Error("expected a password method");
  return method;
}

/** The editor's seams and per-test reset, installed by the suite that calls it. */
export function installEditorHarness(): void {
  let revokeKinds: () => void = () => undefined;
  let revokePacks: () => void = () => undefined;
  beforeAll(() => {
    revokeKinds = registerLegacyItemKinds();
    revokePacks = switchCredentialPacksOn();
  });
  afterAll(() => {
    revokeKinds();
    revokePacks();
  });
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    saveItem.mockResolvedValue(undefined);
    saveItems.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });
}
