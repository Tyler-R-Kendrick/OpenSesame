/**
 * Keep the open vault's own types available (ADR 0165).
 *
 * A pack that is off is a pack the person has not chosen to create more of.
 * It is not a reason for the items they already hold to lose their form.
 * This watches the vault and, for every pack type it holds items of, records
 * how many (so the screen can say why that row has no switch) and installs
 * the type for this document if it is not already — in the background, for
 * the lifetime of the open vault, without remembering it as a choice.
 */

import { itemTypeId } from "@opensesame/vault-core";
import type { VaultItem } from "@opensesame/vault-core";
import { isPackId, isPackLoaded } from "@opensesame/vault-item-types";
import { enablePack } from "./installer.js";
import { isBusy, setCounts, statusOf } from "./state.js";

export type ItemSource = Readonly<{
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => { items: readonly VaultItem[] };
}>;

export function countPackItems(
  items: readonly VaultItem[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const id = itemTypeId(item);
    if (isPackId(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function settle(source: ItemSource): void {
  const counts = countPackItems(source.getSnapshot().items);
  setCounts(counts);
  for (const id of counts.keys()) {
    const { phase } = statusOf(id);
    if (!isPackLoaded(id) && !isBusy(phase) && phase !== "failed") {
      enablePack(id, { keep: false });
    }
  }
}

/** Start watching; returns the stop function. */
export function watchVaultTypes(source: ItemSource): () => void {
  settle(source);
  return source.subscribe(() => settle(source));
}
