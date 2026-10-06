/**
 * What packing items for a trip reads of them (ADR 0171): which cannot leave
 * whole, how they are named, the folders they would empty, and the digests the
 * self-check compares. Split from `items-depart.ts`.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type Folder,
  type VaultItem,
  fileSummary,
} from "@opensesame/vault-core";
import { sha256Hex } from "../capabilities/trust/digest.js";
import { itemText } from "../vault/item-departure.js";
import type { OpenVault } from "./items-depart.js";

function stringsIn(value: BoundaryValue, out: string[] = []): string[] {
  if (isString(value)) out.push(value);
  else if (Array.isArray(value))
    for (const entry of value) stringsIn(entry, out);
  else if (isJsonObject(value)) {
    for (const entry of Object.values(value)) stringsIn(entry, out);
  }
  return out;
}

/**
 * An item that cannot leave whole: a drop is a claim in flight, and a file's
 * ciphertext sits in parts outside the vault that a bundle does not carry.
 */
export function cannotBeHidden(item: VaultItem): boolean {
  return (
    item.kind === "drop" ||
    stringsIn(overlapCast(item)).some((text) => fileSummary(text) !== null)
  );
}

export function label(item: VaultItem): string {
  return item.name.trim() === "" ? "Untitled" : item.name.trim();
}

export type FolderPlan = { named: Folder[]; emptied: string[] };

/** The folders `items` sat in, and those they would leave empty. */
export function foldersOf(
  vault: OpenVault,
  chosen: ReadonlySet<string>,
): FolderPlan {
  const naming = new Set(
    vault.items.flatMap((i) => (chosen.has(i.id) ? (i.folderId ?? []) : [])),
  );
  const staying = new Set(
    vault.items.flatMap((i) => (chosen.has(i.id) ? [] : (i.folderId ?? []))),
  );
  return {
    named: vault.folders.filter((folder) => naming.has(folder.id)),
    emptied: [...naming].filter((id) => !staying.has(id)),
  };
}

export async function digestsOf(
  items: readonly VaultItem[],
): Promise<string[]> {
  return Promise.all(
    items.map((item) =>
      sha256Hex(new TextEncoder().encode(`${item.id}\u0000${itemText(item)}`)),
    ),
  );
}

/** `ids`, and every credential bound to an account among them. */
export function withBoundCredentials(
  items: readonly VaultItem[],
  ids: readonly string[],
): string[] {
  const chosen = new Set(ids);
  const bound = items.flatMap((item) =>
    item.kind === "credential" &&
    item.accountId !== null &&
    chosen.has(item.accountId)
      ? [item.id]
      : [],
  );
  return [...new Set([...ids, ...bound])];
}
