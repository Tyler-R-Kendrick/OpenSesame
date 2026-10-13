import { type VaultItem, itemTypeId, typeLabel } from "@opensesame/vault-core";

function baseName(item: VaultItem): string {
  const name = item.name.trim();
  return name === "" ? "Untitled" : name;
}

export type LiveItemPickLabelOptions = {
  /** Shown on every row so the same name in another vault is not ambiguous. */
  vaultLabel?: string;
};

/**
 * Labels for the live host item picker. When two items share a name, the type
 * disambiguates (`GitHub · Password`). With a vault label, each row names its
 * vault (`GitHub · personal`).
 */
export function liveItemPickLabels(
  items: readonly VaultItem[],
  options: LiveItemPickLabelOptions = {},
): ReadonlyMap<string, string> {
  const vaultSuffix =
    options.vaultLabel && options.vaultLabel.trim() !== ""
      ? ` · ${options.vaultLabel.trim()}`
      : "";
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = baseName(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const item of items) {
    const name = baseName(item);
    const twin = (counts.get(name) ?? 0) > 1;
    const core = twin ? `${name} · ${typeLabel(itemTypeId(item))}` : name;
    labels.set(item.id, `${core}${vaultSuffix}`);
  }
  return labels;
}
