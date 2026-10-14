/**
 * Item writes that retire a password only after the sealed body commits.
 * One seal for the whole set, so a failed import leaves nothing behind
 * (ADR 0130, SB-069).
 */

import {
  type Folder,
  type VaultBody,
  type VaultItem,
  resolveAccounts,
} from "@opensesame/vault-core";
import { applyManifestPlan } from "./body-edits.js";
import { noteSavedItems } from "./item-activity.js";
import { itemText } from "./item-departure.js";
import { writeItem } from "./item-path.js";
import {
  preparePasswordRetirement,
  rememberRetiredDigests,
} from "./password-history.js";
import type { captureStoreOperation } from "./store-operation-check.js";

export type ItemWriteHost = {
  tomb: string;
  items: readonly VaultItem[];
  mutate(change: (body: VaultBody) => void): Promise<void>;
};

/** Hand the original session to a new write turn, which owns authenticated peer-header adoption. */
export function originalItemWriteHost(
  original: Pick<
    ReturnType<typeof captureStoreOperation>,
    "scope" | "active" | "context"
  >,
  items: readonly VaultItem[],
  mutate: (
    change: (body: VaultBody) => void,
    check: () => void,
  ) => Promise<void>,
): ItemWriteHost {
  return {
    tomb: original.scope.tomb,
    items: resolveAccounts(items),
    mutate: (change) => {
      original.active();
      return mutate(change, original.context);
    },
  };
}

export type ManifestWritePlan = {
  adds: VaultItem[];
  updates: VaultItem[];
  newFolders: Folder[];
};

export type ItemImportPlan = {
  items: VaultItem[];
  newFolders: Folder[];
};

export function writeManifestItems(
  host: ItemWriteHost,
  plan: ManifestWritePlan,
): Promise<void> {
  if (plan.adds.length + plan.updates.length + plan.newFolders.length === 0)
    return Promise.resolve();
  return host.mutate((body) => applyManifestPlan(body, plan));
}

export async function writeSavedItems(
  host: ItemWriteHost,
  items: readonly VaultItem[],
  folder?: Folder,
): Promise<void> {
  if (items.length === 0) return;
  const priorIds = new Set(host.items.map((item) => item.id));
  const expected = expectedUpdates(host.items, items);
  const retired = await preparePasswordRetirement(host.tomb, host.items, items);
  await host.mutate((body) => {
    assertExpectedUpdates(body.items, expected);
    for (const item of items) writeItem(body, item, folder);
  });
  noteSavedItems(priorIds, items);
  await rememberRetiredDigests(retired);
}

function expectedUpdates(
  prior: readonly VaultItem[],
  incoming: readonly VaultItem[],
): ReadonlyMap<string, string> {
  const previous = new Map(prior.map((item) => [item.id, item]));
  const expected = new Map<string, string>();
  for (const item of incoming) {
    const current = previous.get(item.id);
    if (current) expected.set(item.id, itemText(current));
  }
  return expected;
}
function assertExpectedUpdates(
  items: readonly VaultItem[],
  expected: ReadonlyMap<string, string>,
): void {
  // The body keeps an account's methods as credentials of their own; the
  // items a caller read are the resolved ones (ADR 0179).
  const current = new Map(
    resolveAccounts(items).map((item) => [item.id, item]),
  );
  for (const [id, text] of expected) {
    const item = current.get(id);
    if (!item || itemText(item) !== text)
      throw new Error("The item changed or left the vault before this update.");
  }
}
