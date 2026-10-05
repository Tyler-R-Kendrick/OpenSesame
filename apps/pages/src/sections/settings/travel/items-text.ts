/**
 * The words of leaving items home (ADR 0170): what a refusal means, what a
 * hide or a return reports, the items a person may choose. Nothing here
 * reads storage; titles appear only while this vault is open in Settings,
 * and nothing remembers them afterwards.
 */

import type {
  ItemReturnStatus,
  ItemsCompleteOutcome,
  ItemsCopy,
  ItemsDepartureReceipt,
  ItemsPackOutcome,
  ItemsReturnPreview,
  ItemsReturnReceipt,
} from "@opensesame/app-core/lib/travel/index.js";
import { cannotBeHidden } from "@opensesame/app-core/lib/travel/index.js";
import { type VaultItem, itemTypeId, typeLabel } from "@opensesame/vault-core";
import { type TravelNotice, plural, travelRefusalText } from "./TravelViews.js";

const COPY_TEXT = {
  backup_target: "a backup target",
  history_snapshot: "a history backup",
  paired_drive: "a paired drive",
  offline_queue: "a queued offline write",
} satisfies Record<ItemsCopy, string>;

const REFUSAL_TEXT = new Map<string, string>([
  ["nothing_chosen", "Choose at least one item to leave home"],
  ["unknown_item", "An item you chose is no longer in this vault"],
  ["item_not_hideable", "A file or a drop cannot leave on its own"],
  ["item_shared", "An item you chose is shared; end the share first"],
  [
    "purge_failed",
    "Something kept about these items could not be cleared; nothing was removed",
  ],
  ["vault_changed", "A different vault is open now; pack again"],
  ["other_vault", "These items were left home by a different vault"],
  [
    "occupied",
    "This vault already holds an item with that id and other content; nothing was changed",
  ],
]);

/** A refusal in the panel's words; a copy that cannot be reached is named. */
export function itemsRefusalText(
  outcome: Extract<ItemsPackOutcome | ItemsCompleteOutcome, { ok: false }>,
): string {
  if (outcome.code === "copies_in_play") {
    const named = outcome.copies.map((copy) => COPY_TEXT[copy]).join(", ");
    return `${named} would hand these items back or keep a copy; not while it is on`;
  }
  return REFUSAL_TEXT.get(outcome.code) ?? travelRefusalText(outcome.code);
}

/** Refusals of the return, from the code the library answers with. */
export function itemsReturnRefusalText(code: string): string {
  return REFUSAL_TEXT.get(code) ?? travelRefusalText(code);
}

/** What can be chosen: live items that can leave whole. */
export function hideableItems(items: readonly VaultItem[]): VaultItem[] {
  return items.filter(
    (item) => item.deletedAt === null && !cannotBeHidden(item),
  );
}

export function itemKindLabel(item: VaultItem): string {
  return typeLabel(itemTypeId(item));
}

export function hiddenNotice(receipt: ItemsDepartureReceipt): TravelNotice {
  const text = `${plural(receipt.hidden.length, "item")} left this vault`;
  return receipt.completion === "applied_local"
    ? { tone: "ok", text }
    : {
        tone: "warn",
        text,
        meta: `${receipt.incomplete.length} trace could not be cleared; press again`,
      };
}

export function itemsReturnedNotice(receipt: ItemsReturnReceipt): TravelNotice {
  return {
    tone: "ok",
    text: `${plural(receipt.returned.length, "item")} came back`,
    ...(receipt.alreadyBack.length > 0
      ? { meta: `${receipt.alreadyBack.length} already here` }
      : undefined),
  };
}

const STATUS = {
  returns: "Comes back",
  already_back: "Already here",
  occupied: "Another item holds this id; left alone",
} satisfies Record<ItemReturnStatus, string>;

export function itemsPreviewFacts(
  preview: ItemsReturnPreview,
): { key: string; value: string }[] {
  return preview.items.map((item) => ({
    key: item.label,
    value: STATUS[item.status],
  }));
}

export function anyItemReturns(preview: ItemsReturnPreview): boolean {
  return (
    preview.items.some((item) => item.status === "returns") &&
    preview.items.every((item) => item.status !== "occupied")
  );
}
