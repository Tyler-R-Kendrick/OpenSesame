/**
 * What a merge does about values for an environment that was removed (ADR 0194).
 *
 * Removing an environment deletes its cells in the same write, on the device
 * that removes it. A device that had not seen the removal can still set a value
 * for that name, and the per-cell merge keeps that write: a secret for an
 * environment that no longer exists, never shown, never in the schema, and back
 * on screen if the name were ever added again. So the merge drops cells whose
 * environment the merged list marks as removed. Only a marker counts: a name the
 * list simply does not mention keeps its cells.
 */

import { overlapCast } from "@opensesame/os-domain";
import type { VaultEnvironments } from "./environments.js";
import type { VaultItem } from "./model.js";

/** The item without cells for removed environments; the same item when none. */
export function withoutRemovedCells(
  item: VaultItem,
  environments: VaultEnvironments | undefined,
): VaultItem {
  const cells = item.environments;
  if (!cells || !environments) return item;
  const entries = Object.entries(cells);
  const kept = entries.filter(
    ([name]) =>
      !(Object.hasOwn(environments, name) && environments[name]?.removed),
  );
  if (kept.length === entries.length) return item;
  // The key stays a key (an empty record), so it stays in the schema.
  return overlapCast({ ...item, environments: Object.fromEntries(kept) });
}
