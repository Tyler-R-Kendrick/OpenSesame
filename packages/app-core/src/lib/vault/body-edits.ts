/**
 * Edits to an open vault body that a merge has to be able to rank (ADR 0144).
 * Each stamps when it was made, so the newer of two devices' copies wins on
 * both; an edit that left no time behind would lose to whichever copy
 * happened to sort higher, and a sync would quietly undo it.
 */
import { type VaultBody, withTombstone } from "@opensesame/vault-core";

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
}
