/**
 * Item writes that retire a password only after the sealed body commits.
 * One seal for the whole set, so a failed import leaves nothing behind
 * (ADR 0130, SB-069).
 */

import type { Folder, VaultBody, VaultItem } from "@opensesame/vault-core";
import { noteSavedItems } from "./item-activity.js";
import { writeItem } from "./item-path.js";
import {
  preparePasswordRetirement,
  rememberRetiredDigests,
} from "./password-history.js";

export type ItemWriteHost = {
  tomb: string;
  items: readonly VaultItem[];
  mutate(change: (body: VaultBody) => void): Promise<void>;
};

export async function writeSavedItems(
  host: ItemWriteHost,
  items: readonly VaultItem[],
  folder?: Folder,
): Promise<void> {
  if (items.length === 0) return;
  const priorIds = new Set(host.items.map((item) => item.id));
  const retired = await preparePasswordRetirement(host.tomb, host.items, items);
  await host.mutate((body) => {
    for (const item of items) writeItem(body, item, folder);
  });
  noteSavedItems(priorIds, items);
  await rememberRetiredDigests(retired);
}
