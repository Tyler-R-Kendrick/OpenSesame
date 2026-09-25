/**
 * Merging two sealed whole-vault snapshots once both are open (ADR 0144).
 *
 * The merge is what makes a dumb drive safe to sync through: it runs on the
 * device, it is deterministic (either argument order converges on the same
 * content), and it never loses a write — the newer copy of each item wins,
 * and a purge or a folder delete travels as a tombstone so the other side's
 * older copy cannot bring it back.
 */
import type {
  Folder,
  InstalledItemTypes,
  VaultBody,
  VaultItem,
  VaultTombstones,
} from "./model.js";

/**
 * Tombstones kept per kind. Ids and times only, so this bounds the body at a
 * few hundred kilobytes; past it the oldest are forgotten first, which can
 * only matter to a device that has been away longer than all of them.
 */
export const MAX_TOMBSTONES = 10_000;

const TOMBSTONE_KINDS = ["items", "folders", "itemTypes"] as const;

/** Deterministic, no-data-loss merge for two encrypted whole-vault snapshots. */
export function mergeVaultBodies(left: VaultBody, right: VaultBody): VaultBody {
  const tombstones = mergeTombstones(left.tombstones, right.tombstones);
  const deadFolders = tombstones?.folders ?? {};
  const deadItems = tombstones?.items ?? {};
  const { itemTypes, itemTypesAt } = mergeItemTypes(
    left,
    right,
    tombstones?.itemTypes ?? {},
  );
  return {
    v: 1,
    items: newest(left.items, right.items, itemVersion)
      .filter((item) => !purgedSince(deadItems[item.id], item))
      .map((item) => rehomed(item, deadFolders)),
    folders: newest(left.folders, right.folders, folderVersion).filter(
      (folder) => deadFolders[folder.id] === undefined,
    ),
    ...(Object.keys(itemTypes).length > 0 ? { itemTypes } : undefined),
    ...(Object.keys(itemTypesAt).length > 0 ? { itemTypesAt } : undefined),
    ...(tombstones ? { tombstones } : undefined),
    rev: Math.max(left.rev ?? 0, right.rev ?? 0),
  };
}

/** Union by id; on a clash the larger version wins, so either order agrees. */
function newest<T extends { id: string }>(
  left: readonly T[],
  right: readonly T[],
  version: (value: T) => string,
): T[] {
  const byId = new Map(left.map((value) => [value.id, value]));
  for (const incoming of right) {
    const current = byId.get(incoming.id);
    if (!current || version(incoming) > version(current)) {
      byId.set(incoming.id, incoming);
    }
  }
  return [...byId.values()];
}

/**
 * Installed definitions merge by type id, the later install winning. A
 * definition is inert data and an id belongs to one publisher (ADR 0087 §7),
 * so either text cannot change what an existing item means. An uninstall
 * removes the type everywhere unless it was installed again afterwards; a
 * definition with no install time (written before ADR 0144) loses to one.
 */
function mergeItemTypes(
  left: VaultBody,
  right: VaultBody,
  dead: Readonly<Record<string, string>>,
) {
  const itemTypes: Record<string, string> = {};
  const itemTypesAt: Record<string, string> = {};
  const ids = new Set([
    ...Object.keys(left.itemTypes ?? {}),
    ...Object.keys(right.itemTypes ?? {}),
  ]);
  for (const id of ids) {
    const install = laterInstall(installed(left, id), installed(right, id));
    const removedAt = dead[id];
    if (!install || (removedAt !== undefined && removedAt >= install.at))
      continue;
    itemTypes[id] = install.text;
    if (install.at) itemTypesAt[id] = install.at;
  }
  return { itemTypes, itemTypesAt };
}

type Install = { text: string; at: string };

function installed(body: VaultBody, id: string): Install | undefined {
  const types: InstalledItemTypes = body.itemTypes ?? {};
  const text = types[id];
  return text === undefined
    ? undefined
    : { text, at: body.itemTypesAt?.[id] ?? "" };
}

function laterInstall(
  left: Install | undefined,
  right: Install | undefined,
): Install | undefined {
  if (!left || !right) return left ?? right;
  return `${right.at}\0${right.text}` > `${left.at}\0${left.text}`
    ? right
    : left;
}

/** An item whose folder was deleted anywhere moves to the root everywhere. */
function rehomed(
  item: VaultItem,
  deadFolders: Readonly<Record<string, string>>,
): VaultItem {
  return item.folderId !== null && deadFolders[item.folderId] !== undefined
    ? { ...item, folderId: null }
    : item;
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

/** A renamed folder carries when; one never renamed dates from its creation. */
function folderVersion(folder: Folder): string {
  return `${folder.updatedAt ?? folder.createdAt}\0${JSON.stringify(folder)}`;
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
  for (const kind of TOMBSTONE_KINDS) {
    const out = new Map(Object.entries(left?.[kind] ?? {}));
    for (const [id, at] of Object.entries(right?.[kind] ?? {})) {
      const seen = out.get(id);
      if (seen === undefined || at > seen) out.set(id, at);
    }
    if (out.size > 0) merged[kind] = Object.fromEntries(out);
  }
  return cap(merged);
}

function cap(tombstones: VaultTombstones): VaultTombstones {
  const out: { -readonly [K in keyof VaultTombstones]: VaultTombstones[K] } =
    {};
  for (const kind of TOMBSTONE_KINDS) {
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
    sortedEntries(body.itemTypesAt),
    ...TOMBSTONE_KINDS.map((kind) => sortedEntries(body.tombstones?.[kind])),
  ]);
}
