/**
 * Merging two sealed whole-vault snapshots once both are open (ADR 0144).
 *
 * The merge is what makes a dumb drive safe to sync through: it runs on the
 * device, it is deterministic (either argument order converges on the same
 * content), and it never loses a write — each field of an item keeps the copy
 * that changed it later (`item-merge.ts`), and a purge or a folder delete
 * travels as a tombstone so the other side's older copy cannot bring it back.
 */
import { mergeDeviceKeyFields } from "./device-key.js";
import { changedAt, mergeItem } from "./item-merge.js";
import type {
  Folder,
  InstalledItemTypes,
  VaultBody,
  VaultItem,
  VaultTombstones,
} from "./model.js";
import { normalizeVaultBody } from "./seal-open.js";
import type { MasterWrap } from "./sync-model.js";

/**
 * Tombstones kept per kind. Ids and times only, so this bounds the body at a
 * few hundred kilobytes; past it the oldest are forgotten first, which can
 * only matter to a device that has been away longer than all of them.
 */
export const MAX_TOMBSTONES = 10_000;

const TOMBSTONE_KINDS = ["items", "folders", "itemTypes"] as const;

/**
 * Deterministic, no-data-loss merge for two encrypted whole-vault snapshots.
 * Either side may still hold a legacy `login` (a device that has not opened
 * its vault since ADR 0172); both are normalized first, so a login and the
 * account another device made of it are one item with one set of methods and
 * the newer copy of it wins as it always did.
 */
export function mergeVaultBodies(
  leftBody: VaultBody,
  rightBody: VaultBody,
): VaultBody {
  const left = normalizeVaultBody(leftBody);
  const right = normalizeVaultBody(rightBody);
  const tombstones = mergeTombstones(left.tombstones, right.tombstones);
  const deadFolders = tombstones?.folders ?? {};
  const deadItems = tombstones?.items ?? {};
  const { itemTypes, itemTypesAt } = mergeItemTypes(
    left,
    right,
    tombstones?.itemTypes ?? {},
  );
  const masterWrap = laterWrap(left.masterWrap, right.masterWrap);
  const deviceIdentityKey = mergeDeviceKeyFields(
    left.deviceIdentityKey,
    right.deviceIdentityKey,
  );
  return {
    v: 1,
    items: mergeItems(left.items, right.items)
      .filter((item) => !purgedSince(deadItems[item.id], item))
      .filter((item) => !orphanedByPurge(item, deadItems))
      .map((item) => rehomed(item, deadFolders)),
    folders: newest(left.folders, right.folders, folderVersion).filter(
      (folder) => deadFolders[folder.id] === undefined,
    ),
    ...(Object.keys(itemTypes).length > 0 ? { itemTypes } : undefined),
    ...(Object.keys(itemTypesAt).length > 0 ? { itemTypesAt } : undefined),
    ...(tombstones ? { tombstones } : undefined),
    ...(deviceIdentityKey ? { deviceIdentityKey } : undefined),
    ...(masterWrap ? { masterWrap } : undefined),
    rev: Math.max(left.rev ?? 0, right.rev ?? 0),
  };
}

/** Union by id; two copies of one item merge field by field. */
function mergeItems(
  left: readonly VaultItem[],
  right: readonly VaultItem[],
): VaultItem[] {
  const byId = new Map(left.map((item) => [item.id, item]));
  for (const incoming of right) {
    const current = byId.get(incoming.id);
    byId.set(incoming.id, current ? mergeItem(current, incoming) : incoming);
  }
  return [...byId.values()];
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

/** The password set or removed last wins; content breaks a tie, so either order agrees. */
function laterWrap(
  left: MasterWrap | undefined,
  right: MasterWrap | undefined,
): MasterWrap | undefined {
  if (!left || !right) return left ?? right;
  const key = (wrap: MasterWrap) => `${wrap.at}\0${JSON.stringify(wrap)}`;
  return key(right) > key(left) ? right : left;
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
  return (
    contentKey(normalizeVaultBody(left)) ===
    contentKey(normalizeVaultBody(right))
  );
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

/** A renamed folder carries when; one never renamed dates from its creation. */
function folderVersion(folder: Folder): string {
  return `${folder.updatedAt ?? folder.createdAt}\0${JSON.stringify(folder)}`;
}

/** An edit made after the purge — on a device that had not heard of it — survives. */
function purgedSince(at: string | undefined, item: VaultItem): boolean {
  return at !== undefined && at >= changedAt(item);
}

/**
 * A credential goes with the account it was bound to (ADR 0178): one a stale
 * copy of a purged account brings back, extracted from its methods, has no
 * tombstone of its own and must not outlive it as a password nothing opens. One
 * changed after the purge, or kept on its own, stays.
 */
function orphanedByPurge(
  item: VaultItem,
  dead: Readonly<Record<string, string>>,
): boolean {
  return (
    item.kind === "credential" &&
    item.accountId !== null &&
    purgedSince(dead[item.accountId], item)
  );
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
    body.deviceIdentityKey ?? null,
    body.masterWrap ?? null,
  ]);
}
