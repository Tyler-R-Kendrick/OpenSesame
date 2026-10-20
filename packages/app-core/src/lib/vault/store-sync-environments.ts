/** Preserve environment cells and exclusion state when older whole-item imports omit them. */
import { overlapCast } from "@opensesame/os-domain";
import type { VaultItem } from "@opensesame/vault-core";

export function withImportedEnvironments(
  current: VaultItem,
  incoming: VaultItem,
  value: VaultItem,
): VaultItem {
  let next = value;
  // An entry written before environments cannot say what an item's cells
  // are: it must not erase them (ADR 0194). An entry that says the item is
  // out of the schema carries no cells, by construction.
  if (incoming.environmentsExcluded) {
    const { environments: _cells, ...withoutCells } = next;
    next = overlapCast(withoutCells);
  } else if (!incoming.environments && current.environments) {
    next.environments = current.environments;
  }
  if (
    !incoming.environmentsExcluded &&
    !incoming.environments &&
    current.environmentsExcluded
  ) {
    const { environments: _cells, ...withoutCells } = next;
    next = overlapCast({ ...withoutCells, environmentsExcluded: true });
  }
  return next;
}
