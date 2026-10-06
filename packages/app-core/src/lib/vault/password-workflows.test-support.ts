import {
  type AccountItem,
  type VaultBody,
  type VaultItem,
  createItem,
  emptyBody,
  extractEmbeddedMethods,
  manualPassword,
  resolveAccounts,
} from "@opensesame/vault-core";
import { vi } from "vitest";
import { stampedEdit } from "./body-edits.js";
import { writeItem } from "./item-path.js";
import type { VaultState } from "./store-state.js";
import { vaultStore } from "./store.js";
export function testAccount(name: string, secret = ""): AccountItem {
  const account = createItem("account", name);
  account.methods = [
    manualPassword(`${account.id}:password`, secret, account.updatedAt),
  ];
  return account;
}
/** The body a vault holds for `items`: an account's methods are entries of their own (ADR 0179). */
export function sealedBody(items: readonly VaultItem[]): VaultBody {
  return { ...emptyBody(), items: extractEmbeddedMethods(items) };
}
/** What the store's snapshot reads out of a body. */
export function readBody(body: VaultBody): VaultItem[] {
  return resolveAccounts(body.items);
}
export function openWorkflowVault(items: VaultItem[]): VaultState {
  const state: VaultState = {
    ...vaultStore.getSnapshot(),
    status: "unlocked",
    tomb: "personal",
    awaitingSecondStep: false,
    items,
  };
  vi.spyOn(vaultStore, "getSnapshot").mockImplementation(() => state);
  vi.spyOn(vaultStore, "saveItem").mockImplementation(async (item) => {
    const body = sealedBody(state.items);
    stampedEdit((draft) => writeItem(draft, item))(body);
    // The store's snapshot is the resolved view (ADR 0179).
    state.items = readBody(body);
  });
  return state;
}
