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
import {
  isPackId,
  isPackLoaded,
  packEntries,
} from "@opensesame/vault-item-types";
import { enablePack } from "./installer.js";
import { packsNeeded } from "./requires.js";
import { isBusy, setCounts, statusOf, subscribePackState } from "./state.js";

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

/**
 * A pack that is on brings the packs it cannot work without (ADR 0179): a
 * vault whose Accounts were switched on before Password was a pack of its own
 * gets Password, so its accounts can be given credentials and a password can
 * be written on its own.
 */
function settleNeeds(): void {
  for (const entry of packEntries()) {
    if (statusOf(entry.id).phase !== "on") continue;
    for (const need of packsNeeded(entry.id)) {
      const { phase } = statusOf(need);
      if (phase === "off") enablePack(need);
    }
  }
}

/** Start watching; returns the stop function. */
export function watchVaultTypes(source: ItemSource): () => void {
  settle(source);
  settleNeeds();
  const stopItems = source.subscribe(() => settle(source));
  const stopPacks = subscribePackState(settleNeeds);
  return () => {
    stopItems();
    stopPacks();
  };
}
