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
  boundCredentials,
  captureBefore,
  extractEmbeddedMethods,
  hasEmbeddedMethods,
  restampEdits,
  splitAccount,
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
    // A write that left an account carrying methods (an import, a replaced
    // list) keeps each as a credential of its own (ADR 0179).
    if (hasEmbeddedMethods(body.items)) {
      body.items = extractEmbeddedMethods(body.items);
    }
    restampEdits(before, body);
  };
}

function now(): string {
  return new Date().toISOString();
}

/**
 * An account's credentials go to the trash with it, at the same instant, so
 * restoring the account brings back those that went with it and not one the
 * person had already removed from it (ADR 0179).
 */
export function trashItem(body: VaultBody, id: string): void {
  const at = now();
  const alongside = new Set(
    boundCredentials(body.items, id).map((credential) => credential.id),
  );
  body.items = body.items.map((item) =>
    item.id === id || alongside.has(item.id)
      ? { ...item, deletedAt: at }
      : item,
  );
}

/** An account's credentials are purged with it; a credential purged alone leaves the account. */
export function purgeItem(body: VaultBody, id: string): void {
  const gone = new Set([id]);
  for (const item of body.items) {
    if (item.kind === "credential" && item.accountId === id) gone.add(item.id);
  }
  body.items = body.items.filter((item) => !gone.has(item.id));
  body.tombstones = withTombstone(body.tombstones, "items", [...gone]);
}

/** A revoked drop must not come back from the trash still looking openable. */
export function expireDropClaims(
  body: VaultBody,
  claimIds: ReadonlySet<string>,
): void {
  let changed = false;
  const items = body.items.map((item) => {
    if (
      item.kind !== "drop" ||
      item.state !== "pending" ||
      !claimIds.has(item.claimId)
    ) {
      return item;
    }
    changed = true;
    const expired: VaultItem = { ...item, state: "expired" };
    return expired;
  });
  if (changed) body.items = items;
}

export function emptyTrash(body: VaultBody): void {
  const gone = body.items.filter((item) => item.deletedAt !== null);
  body.items = body.items.filter((item) => item.deletedAt === null);
  body.tombstones = withTombstone(
    body.tombstones,
    "items",
    gone.map((item) => item.id),
  );
}

export function deleteFolder(body: VaultBody, id: string): void {
  body.folders = body.folders.filter((folder) => folder.id !== id);
  body.tombstones = withTombstone(body.tombstones, "folders", [id]);
  body.items = body.items.map((item) =>
    item.folderId === id ? { ...item, folderId: null } : item,
  );
}

export function restoreItem(body: VaultBody, id: string): void {
  const at = now();
  const trashedWith = body.items.find((item) => item.id === id)?.deletedAt;
  body.items = body.items.map((item) => {
    if (item.id === id) return { ...item, deletedAt: null, updatedAt: at };
    const together =
      item.kind === "credential" &&
      item.accountId === id &&
      trashedWith !== undefined &&
      trashedWith !== null &&
      item.deletedAt === trashedWith;
    return together ? { ...item, deletedAt: null, updatedAt: at } : item;
  });
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
  body.masterWrap = merged.masterWrap;
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
    ...(body.masterWrap !== undefined
      ? { masterWrap: body.masterWrap }
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
  const flagged = new Set(body.items.filter(isLegacySample).map((i) => i.id));
  // An account's credentials go with it (ADR 0179).
  const isGone = (item: VaultItem) =>
    flagged.has(item.id) ||
    (item.kind === "credential" &&
      item.accountId !== null &&
      flagged.has(item.accountId));
  const gone = body.items.filter(isGone);
  if (gone.length === 0) return;
  const kept = body.items.filter((item) => !isGone(item));
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
  body.folders = [...body.folders, ...plan.newFolders];
  for (const item of plan.updates) {
    const next = { ...item, updatedAt: at };
    // An account is rewritten with the methods the manifest names (ADR 0179).
    body.items =
      next.kind === "account"
        ? splitAccount(body.items, next, at)
        : body.items.map((held) => (held.id === item.id ? next : held));
  }
  body.items = [...body.items, ...plan.adds];
}

/** Add items, and the folders they need, in one write. */
export function appendItems(
  body: VaultBody,
  items: readonly VaultItem[],
  folders: readonly Folder[],
): void {
  body.folders = [...body.folders, ...folders];
  body.items = [...body.items, ...items];
}

/** Replace every item and folder, as a restore does. */
export function replaceItems(
  body: VaultBody,
  items: VaultItem[],
  folders: Folder[],
): void {
  body.items = items;
  body.folders = folders;
}
