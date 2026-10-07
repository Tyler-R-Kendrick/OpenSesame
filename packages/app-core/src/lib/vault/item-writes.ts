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
import { noteSavedItems } from "./item-activity.js";
import { itemText } from "./item-departure.js";
import { writeItem } from "./item-path.js";
import {
  preparePasswordRetirement,
  rememberRetiredDigests,
} from "./password-history.js";

export type ItemWriteHost = {
  tomb: string;
  items: readonly VaultItem[];
  check?: () => void;
  mutate(change: (body: VaultBody) => void): Promise<void>;
};

export async function writeSavedItems(
  host: ItemWriteHost,
  items: readonly VaultItem[],
  folder?: Folder,
): Promise<void> {
  if (items.length === 0) return;
  host.check?.();
  const priorIds = new Set(host.items.map((item) => item.id));
  const expected = expectedUpdates(host.items, items);
  const retired = await preparePasswordRetirement(
    host.tomb,
    host.items,
    items,
    host.check,
  );
  host.check?.();
  await host.mutate((body) => {
    assertExpectedUpdates(body.items, expected);
    for (const item of items) writeItem(body, item, folder);
  });
  host.check?.();
  noteSavedItems(priorIds, items);
  await rememberRetiredDigests(retired, host.check);
  host.check?.();
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
