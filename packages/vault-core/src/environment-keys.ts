/**
 * Which items may be keys in a vault's `.env.schema` (ADR 0190). The format's
 * rule, so the store can refuse an edit that breaks it without reaching into
 * the optional capability that draws the schema.
 */

import { type VaultItem, isRetired } from "./model.js";

/** Live, not retired, and not a one-time share record. */
export function canBeKey(item: VaultItem): boolean {
  return item.deletedAt === null && !isRetired(item) && item.kind !== "drop";
}
