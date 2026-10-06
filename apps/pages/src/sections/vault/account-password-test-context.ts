import { shareReachSeams } from "@opensesame/app-core/lib/local-share-reach.js";
import { stampedEdit } from "@opensesame/app-core/lib/vault/body-edits.js";
import { writeItem } from "@opensesame/app-core/lib/vault/item-path.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type VaultItem,
  emptyBody,
  extractEmbeddedMethods,
  resolveAccounts,
} from "@opensesame/vault-core";
import { vi } from "vitest";

/** The real shared password writer sees an authoritative body, separate from a stale open UI. */
export function bindAccountPasswordCore(
  read: () => VaultItem[],
  save: (item: VaultItem) => Promise<void>,
): (items: VaultItem[]) => void {
  const snapshot = vaultStore.getSnapshot();
  let authoritativeItems: VaultItem[] | null = null;
  vi.spyOn(vaultStore, "getSnapshot").mockImplementation(() => ({
    ...snapshot,
    status: "unlocked",
    awaitingSecondStep: false,
    tomb: "personal",
    items: authoritativeItems ?? read(),
  }));
  vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
    "operator",
  );
  vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
  vi.spyOn(vaultStore, "saveItem").mockImplementation(async (next) => {
    await save(next);
    authoritativeItems = persistPasswordTestItem(
      authoritativeItems ?? read(),
      next,
    );
  });
  return (items) => {
    authoritativeItems = items;
  };
}

/** Persist test writes through the same content and field-clock owners as VaultStore. */
export function persistPasswordTestItem(
  items: VaultItem[],
  next: VaultItem,
): VaultItem[] {
  // An account's methods are entries of their own in the body (ADR 0178); the
  // snapshot a surface reads is the resolved view.
  const body = { ...emptyBody(), items: extractEmbeddedMethods(items) };
  stampedEdit((draft) => writeItem(draft, next))(body);
  return resolveAccounts(body.items);
}
