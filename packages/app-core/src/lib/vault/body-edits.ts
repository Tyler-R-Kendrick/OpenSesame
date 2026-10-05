/**
 * Edits to an open vault body that a merge has to be able to rank (ADR 0144).
 * Each stamps when it was made, so the newer of two devices' copies wins on
 * both; an edit that left no time behind would lose to whichever copy
 * happened to sort higher, and a sync would quietly undo it.
 */
import {
  type Folder,
  type VaultBody,
  type VaultItem,
  captureBefore,
  restampEdits,
  withTombstone,
} from "@opensesame/vault-core";

/**
 * A local edit, stamped after everything the body had already seen, with the
 * item fields it changed recorded (`stamps.ts`): a device whose clock runs
 * behind still wins over the copy it edited. Merges never go through this.
 */
export function stampedEdit(
  change: (body: VaultBody) => void,
): (body: VaultBody) => void {
  return (body) => {
    const before = captureBefore(body);
    change(body);
    restampEdits(before, body);
  };
}

function now(): string {
  return new Date().toISOString();
}

export function restoreItem(body: VaultBody, id: string): void {
  const at = now();
  body.items = body.items.map((item) =>
    item.id === id ? { ...item, deletedAt: null, updatedAt: at } : item,
  );
}

export function toggleFavorite(body: VaultBody, id: string): void {
  const at = now();
  body.items = body.items.map((item) =>
    item.id === id
      ? { ...item, favorite: !item.favorite, updatedAt: at }
      : item,
  );
}

export function renameFolder(body: VaultBody, id: string, name: string): void {
  const at = now();
  body.folders = body.folders.map((folder) =>
    folder.id === id ? { ...folder, name: name.trim(), updatedAt: at } : folder,
  );
}

/**
 * Carry the registry's definitions into the body, stamping the ones `added`
 * names and tombstoning the ones `removed` names.
 */
export function recordItemTypes(
  body: VaultBody,
  installed: Readonly<Record<string, string>>,
  change: { added?: readonly string[]; removed?: readonly string[] },
): void {
  const at = now();
  const times: Record<string, string> = {};
  for (const [id, time] of Object.entries(body.itemTypesAt ?? {})) {
    if (installed[id] !== undefined) times[id] = time;
  }
  for (const id of change.added ?? []) times[id] = at;
  body.itemTypes = installed;
  body.itemTypesAt = times;
  if (change.removed?.length) {
    body.tombstones = withTombstone(
      body.tombstones,
      "itemTypes",
      change.removed,
      at,
    );
  }
}

/**
 * Make `body` the merge result, keeping its own write counter. Every content
 * key is replaced, so one the merge dropped — the last installed type, say —
 * goes too, where spreading the result over the body would keep it.
 */
export function adoptMerged(body: VaultBody, merged: VaultBody): void {
  body.items = merged.items;
  body.folders = merged.folders;
  body.itemTypes = merged.itemTypes ?? {};
  body.itemTypesAt = merged.itemTypesAt;
  body.tombstones = merged.tombstones;
  body.deviceIdentityKey = merged.deviceIdentityKey;
}

/** A copy of what a failed write must put back, so memory never runs ahead of disk. */
export function bodyBeforeWrite(body: VaultBody): VaultBody {
  return {
    v: body.v,
    items: body.items,
    folders: body.folders,
    ...(body.itemTypes !== undefined
      ? { itemTypes: body.itemTypes }
      : undefined),
    ...(body.itemTypesAt !== undefined
      ? { itemTypesAt: body.itemTypesAt }
      : undefined),
    ...(body.rev !== undefined ? { rev: body.rev } : undefined),
    tombstones: body.tombstones,
    ...(body.deviceIdentityKey !== undefined
      ? { deviceIdentityKey: body.deviceIdentityKey }
      : undefined),
  };
}

/** An item the retired sample-data feature wrote: its flag is no longer typed. */
function isLegacySample(item: VaultItem): boolean {
  // SAFETY: sample is a retired field the item contract no longer types; the stored object still carries the checked flag.
  return (item as { sample?: boolean }).sample === true;
}

/**
 * Take out what the retired sample-data feature left in a vault: every item
 * it flagged, live or trashed, and each folder only those items sat in —
 * tombstoned, so a merge from a device that still holds them cannot bring
 * them back. A real item is never touched: a folder one also sits in stays,
 * and nothing is moved.
 */
export function retireLegacySample(body: VaultBody): void {
  const gone = body.items.filter(isLegacySample);
  if (gone.length === 0) return;
  const kept = body.items.filter((item) => !isLegacySample(item));
  const folders = new Set(gone.flatMap((item) => item.folderId ?? []));
  for (const item of kept) if (item.folderId) folders.delete(item.folderId);
  const at = now();
  body.items = kept;
  body.folders = body.folders.filter((folder) => !folders.has(folder.id));
  body.tombstones = withTombstone(
    body.tombstones,
    "items",
    gone.map((item) => item.id),
    at,
  );
  if (folders.size > 0) {
    body.tombstones = withTombstone(
      body.tombstones,
      "folders",
      [...folders],
      at,
    );
  }
}

/** A store-path manifest's merge plan (`planManifestMerge`), in one write. */
export function applyManifestPlan(
  body: VaultBody,
  plan: { adds: VaultItem[]; updates: VaultItem[]; newFolders: Folder[] },
): void {
  const at = now();
  const updated = new Map(
    plan.updates.map((item) => [item.id, { ...item, updatedAt: at }]),
  );
  body.folders = [...body.folders, ...plan.newFolders];
  body.items = [
    ...body.items.map((item) => updated.get(item.id) ?? item),
    ...plan.adds,
  ];
}
