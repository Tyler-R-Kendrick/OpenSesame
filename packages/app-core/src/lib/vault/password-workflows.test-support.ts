import {
  type AccountItem,
  type VaultItem,
  createItem,
  emptyBody,
  manualPassword,
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
    const body = { ...emptyBody(), items: state.items };
    stampedEdit((draft) => writeItem(draft, item))(body);
    state.items = body.items;
  });
  return state;
}
