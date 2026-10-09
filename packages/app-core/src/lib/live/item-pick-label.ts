import { itemTypeId, type VaultItem, typeLabel } from "@opensesame/vault-core";

function baseName(item: VaultItem): string {
  const name = item.name.trim();
  return name === "" ? "Untitled" : name;
}

/**
 * Labels for the live host item picker. When two items share a name, the type
 * disambiguates (`GitHub · Password`).
 */
export function liveItemPickLabels(
  items: readonly VaultItem[],
): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = baseName(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const item of items) {
    const name = baseName(item);
    const twin = (counts.get(name) ?? 0) > 1;
    labels.set(
      item.id,
      twin ? `${name} · ${typeLabel(itemTypeId(item))}` : name,
    );
  }
  return labels;
}
