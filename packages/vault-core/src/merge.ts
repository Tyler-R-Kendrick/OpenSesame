/**
 * Merging two sealed whole-vault snapshots once both are open (ADR 0140).
 *
 * The merge is what makes a dumb drive safe to sync through: it runs on the
 * device, it is deterministic (either argument order converges on the same
 * content), and it never loses a write — the newer copy of each item wins,
 * and a purge or a folder delete travels as a tombstone so the other side's
 * older copy cannot bring it back.
 */
import type { Folder, VaultBody, VaultItem, VaultTombstones } from "./model.js";

/**
 * Tombstones kept per kind. Ids and times only, so this bounds the body at a
 * few hundred kilobytes; past it the oldest are forgotten first, which can
 * only matter to a device that has been away longer than all of them.
 */
export const MAX_TOMBSTONES = 10_000;

/** Deterministic, no-data-loss merge for two encrypted whole-vault snapshots. */
export function mergeVaultBodies(left: VaultBody, right: VaultBody): VaultBody {
  const tombstones = mergeTombstones(left.tombstones, right.tombstones);
  const items = new Map(left.items.map((item) => [item.id, item]));
  for (const incoming of right.items) {
    const current = items.get(incoming.id);
    if (!current || itemVersion(incoming) > itemVersion(current)) {
      items.set(incoming.id, incoming);
    }
  }
  const folders = new Map(left.folders.map((folder) => [folder.id, folder]));
  for (const incoming of right.folders) {
    const current = folders.get(incoming.id);
    if (!current || JSON.stringify(incoming) > JSON.stringify(current)) {
      folders.set(incoming.id, incoming);
    }
  }
  const deadFolders = tombstones?.folders ?? {};
  const deadItems = tombstones?.items ?? {};
  // Installed definitions merge by type id. A definition is inert data and an
  // id belongs to one publisher (ADR 0087 §7), so taking the incoming text on
  // a conflict cannot change what any existing item means.
  const itemTypes = { ...left.itemTypes };
  for (const [id, text] of Object.entries(right.itemTypes ?? {})) {
    if (text !== undefined) itemTypes[id] = text;
  }
  return {
    v: 1,
    items: [...items.values()]
      .filter((item) => !purgedSince(deadItems[item.id], item))
      .map((item) =>
        item.folderId !== null && deadFolders[item.folderId] !== undefined
          ? { ...item, folderId: null }
          : item,
      ),
    folders: [...folders.values()].filter(
      (folder: Folder) => deadFolders[folder.id] === undefined,
    ),
    ...(Object.keys(itemTypes).length > 0 ? { itemTypes } : undefined),
    ...(tombstones ? { tombstones } : undefined),
    rev: Math.max(left.rev ?? 0, right.rev ?? 0),
  };
}

/** True when both bodies hold the same vault, whatever their write counters say. */
export function sameVaultContent(left: VaultBody, right: VaultBody): boolean {
  return contentKey(left) === contentKey(right);
}

/** Record a purge or delete in a body's tombstones, returning the new set. */
export function withTombstone(
  current: VaultTombstones | undefined,
  kind: keyof VaultTombstones,
  ids: readonly string[],
  at: string = new Date().toISOString(),
): VaultTombstones {
  const next = { ...current?.[kind] };
  for (const id of ids) next[id] = at;
  return cap({ ...current, [kind]: next });
}

function changedAt(item: VaultItem): string {
  return item.deletedAt && item.deletedAt > item.updatedAt
    ? item.deletedAt
    : item.updatedAt;
}

function itemVersion(item: VaultItem): string {
  return `${changedAt(item)}\0${JSON.stringify(item)}`;
}

/** An edit made after the purge — on a device that had not heard of it — survives. */
function purgedSince(at: string | undefined, item: VaultItem): boolean {
  return at !== undefined && at >= changedAt(item);
}

function mergeTombstones(
  left: VaultTombstones | undefined,
  right: VaultTombstones | undefined,
): VaultTombstones | undefined {
  if (!left && !right) return undefined;
  const merged: { -readonly [K in keyof VaultTombstones]: VaultTombstones[K] } =
    {};
  for (const kind of ["items", "folders"] as const) {
    const out: Record<string, string> = { ...left?.[kind] };
    for (const [id, at] of Object.entries(right?.[kind] ?? {})) {
      const seen = out[id];
      if (seen === undefined || at > seen) out[id] = at;
    }
    if (Object.keys(out).length > 0) merged[kind] = out;
  }
  return cap(merged);
}

function cap(tombstones: VaultTombstones): VaultTombstones {
  const out: { -readonly [K in keyof VaultTombstones]: VaultTombstones[K] } =
    {};
  for (const kind of ["items", "folders"] as const) {
    const entries = Object.entries(tombstones[kind] ?? {});
    if (entries.length === 0) continue;
    entries.sort(([ia, a], [ib, b]) =>
      a === b ? ia.localeCompare(ib) : b.localeCompare(a),
    );
    out[kind] = Object.fromEntries(entries.slice(0, MAX_TOMBSTONES));
  }
  return out;
}

function sortedEntries(record: Readonly<Record<string, string>> | undefined) {
  return Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

function contentKey(body: VaultBody): string {
  const byId = <T extends { id: string }>(list: readonly T[]) =>
    [...list].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify([
    byId(body.items),
    byId(body.folders),
    sortedEntries(body.itemTypes),
    sortedEntries(body.tombstones?.items),
    sortedEntries(body.tombstones?.folders),
  ]);
}
