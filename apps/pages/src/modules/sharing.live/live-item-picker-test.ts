import { liveItemPickLabels } from "@opensesame/app-core/lib/live/item-pick-label.js";
import { activeItems, listedItems, type VaultItem } from "@opensesame/vault-core";

/** Checkbox label the live host item picker draws (B9). */
export function liveItemPickerCheckboxName(
  item: VaultItem,
  vaultLabel = "personal",
): string {
  const live = listedItems(activeItems([item]));
  const label = liveItemPickLabels(live, { vaultLabel }).get(item.id);
  if (!label) throw new Error("item not listed for live picker");
  return label;
}
