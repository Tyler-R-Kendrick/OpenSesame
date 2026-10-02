/**
 * One activity line per item a save committed. The sealed value stays in
 * the item; the log carries the kind, the action, the id, and the name.
 */

import type { VaultItem } from "@opensesame/vault-core";
import { itemTypeId, typeLabel } from "@opensesame/vault-core";
import { emitActivity } from "../activity-log.js";

function phraseLabel(id: string): string {
  const label = typeLabel(id);
  const rest = label.slice(1);
  if (rest === rest.toLowerCase()) return label.toLowerCase();
  return label;
}

function itemName(item: VaultItem): string {
  const name = item.name.trim().replaceAll(/\s+/gu, " ");
  if (name.length <= 120) return name;
  return `${name.slice(0, 119)}…`;
}

function savedSummary(item: VaultItem, created: boolean): string {
  const name = itemName(item);
  const named = name ? `: ${name}` : "";
  if (itemTypeId(item) === "secret") {
    return created
      ? `A new secret was generated${named}`
      : `A secret was updated${named}`;
  }
  const label = phraseLabel(itemTypeId(item));
  return created
    ? `A new ${label} was created${named}`
    : `A ${label} was updated${named}`;
}

/** Call only after the sealed mutation has committed. */
export function noteSavedItems(
  priorIds: ReadonlySet<string>,
  items: readonly VaultItem[],
): void {
  const seen = new Set(priorIds);
  for (const item of items) {
    const created = !seen.has(item.id);
    seen.add(item.id);
    const kind = itemTypeId(item);
    emitActivity({
      category: "vault",
      type: created ? `vault.${kind}.created` : `vault.${kind}.updated`,
      summary: savedSummary(item, created),
      outcome: "succeeded",
      targetType: kind,
      targetId: item.id,
      metadata: { kind, action: created ? "created" : "updated" },
    });
  }
}
