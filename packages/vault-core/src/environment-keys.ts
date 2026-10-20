/**
 * Which items may be keys in a vault's `.env.schema` (ADR 0194). The format's
 * rule, so the store can refuse an edit that breaks it without reaching into
 * the optional capability that draws the schema.
 */

import { type VaultItem, isRetired } from "./model.js";

/**
 * Live, not retired, not a one-time share record, and not a credential that
 * rides inside its account's sealed-store entry. A bound credential cannot keep
 * environment cells through that entry, so it is not offered as a key.
 */
export function canBeKey(item: VaultItem): boolean {
  return (
    item.deletedAt === null &&
    !isRetired(item) &&
    item.kind !== "drop" &&
    !(item.kind === "credential" && item.accountId !== null)
  );
}

/** Every live secret the store can carry on its own, unless taken out (ADR 0194). */
export function isEnvironmentKey(item: VaultItem): boolean {
  return canBeKey(item) && item.environmentsExcluded !== true;
}
