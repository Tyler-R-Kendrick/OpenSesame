/**
 * Items that leave an open vault for a trip, and come back (ADR 0171).
 *
 * A normal removal leaves traces on purpose: trash keeps a copy, a purge
 * writes a tombstone so a sync cannot bring the item back, a save writes an
 * activity line. Here the point is the opposite, so these two edits write
 * none of those. They run inside one sealed mutation, from the body the disk
 * holds, and refuse before touching anything: an item that is not what was
 * packed is never taken, and one that is back already is never doubled.
 */

import { canonicalize, overlapCast } from "@opensesame/os-domain";
import type { Folder, VaultBody, VaultItem } from "@opensesame/vault-core";

export type ItemDepartureCode =
  /** An item in the plan is not the one that was packed. */
  | "item_changed"
  /** The vault already holds an id the bundle carries, with other content. */
  | "item_occupied";

export class ItemDepartureError extends Error {
  readonly code: ItemDepartureCode;
  readonly ids: readonly string[];

  constructor(code: ItemDepartureCode, ids: readonly string[]) {
    super(
      code === "item_changed"
        ? "An item changed after it was packed."
        : "The vault already holds an item with that id and other content.",
    );
    this.name = "ItemDepartureError";
    this.code = code;
    this.ids = ids;
  }
}

/** One item as a byte-for-byte comparable string. */
export function itemText(item: VaultItem): string {
  // A vault item is plain JSON by construction: it is sealed and parsed as such.
  return canonicalize(overlapCast(item));
}

/** What leaves: each item with the text it was packed as, and the folders it may empty. */
export type ItemWithdrawal = Readonly<{
  items: Readonly<Record<string, string>>;
  /** Removed only if nothing left in the vault sits in them. */
  folderIds: readonly string[];
}>;

/** What comes back: the items exactly as they left, and the folders they named. */
export type ItemReturn = Readonly<{
  items: readonly VaultItem[];
  folders: readonly Folder[];
}>;

function without<T>(
  record: Readonly<Record<string, T>> | undefined,
  ids: ReadonlySet<string>,
): Record<string, T> | undefined {
  if (record === undefined) return undefined;
  const kept = Object.entries(record).filter(([id]) => !ids.has(id));
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/**
 * Take the packed items out of `body`. An item already gone is skipped, which
 * is what lets a removal that was cut short be finished; one that differs
 * from what was packed refuses the whole change.
 */
export function withdrawFromBody(body: VaultBody, plan: ItemWithdrawal): void {
  const changed = body.items
    .filter((item) => {
      const packed = plan.items[item.id];
      return packed !== undefined && packed !== itemText(item);
    })
    .map((item) => item.id);
  if (changed.length > 0) throw new ItemDepartureError("item_changed", changed);
  const kept = body.items.filter((item) => plan.items[item.id] === undefined);
  const used = new Set(kept.flatMap((item) => item.folderId ?? []));
  const emptied = new Set(plan.folderIds.filter((id) => !used.has(id)));
  body.items = kept;
  body.folders = body.folders.filter((folder) => !emptied.has(folder.id));
}

/**
 * Put `back` into `body`. The vault's own folder wins over the bundle's, a
 * missing one is recreated under its own id, and a tombstone for something
 * the person is bringing back by hand is dropped with it.
 */
export function restoreIntoBody(body: VaultBody, back: ItemReturn): void {
  const held = new Map(body.items.map((item) => [item.id, item]));
  const occupied = back.items
    .filter((item) => {
      const there = held.get(item.id);
      return there !== undefined && itemText(there) !== itemText(item);
    })
    .map((item) => item.id);
  if (occupied.length > 0)
    throw new ItemDepartureError("item_occupied", occupied);
  const adding = back.items.filter((item) => !held.has(item.id));
  const folderIds = new Set(body.folders.map((folder) => folder.id));
  const recreated = back.folders.filter(
    (folder) =>
      !folderIds.has(folder.id) &&
      adding.some((item) => item.folderId === folder.id),
  );
  body.items = [...body.items, ...adding];
  body.folders = [...body.folders, ...recreated];
  const tombs = body.tombstones;
  if (!tombs) return;
  const items = without(tombs.items, new Set(adding.map((i) => i.id)));
  const folders = without(tombs.folders, new Set(recreated.map((f) => f.id)));
  body.tombstones = {
    ...(items ? { items } : undefined),
    ...(folders ? { folders } : undefined),
    ...(tombs.itemTypes ? { itemTypes: tombs.itemTypes } : undefined),
  };
}
