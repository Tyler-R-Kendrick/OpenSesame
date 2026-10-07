import { assertNotDecoySession } from "../lib/decoy-session.js";
/**
 * Helpers every WebMCP tool group shares: argument readers, the unlocked
 * gate, the ceremony opener, and the support seam. Nothing here names a
 * tool; each group (`boot-tools`, `vault-tools`, `connections-tools`,
 * `identity-tools`, `settings-tools`, `support-tools`, `login-tools`,
 * `wallet-tools`) is contributed by the capability that owns its operations
 * and aggregated for tests in `tools.ts`.
 */

import { type Named, name } from "@gdp-ts/core";
import { type JsonObject, isString } from "@opensesame/os-domain";
import type { VaultItem } from "@opensesame/vault-core";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import {
  type ItemReadReach,
  type ItemWriteReach,
  reachItemRead,
  reachItemWrite,
} from "../lib/proofs/item-reach.js";
import { vaultStore } from "../lib/vault/store.js";
import { webmcpNavigationSeam } from "./seams.js";

export { type WebMcpSupportSeam, webmcpSupportSeam } from "./seams.js";

export type PagesWebMcpTool = WebMcpToolSpec & {
  capabilityIds: readonly string[];
  scope: "boot" | "session";
};

export function str(args: JsonObject, key: string): string {
  const value = args[key];
  if (!isString(value) || value.length === 0) {
    throw new Error(`missing_argument:${key}`);
  }
  return value;
}

export function optStr(args: JsonObject, key: string): string | null {
  const value = args[key];
  return isString(value) && value.length > 0 ? value : null;
}

export function requireUnlocked(): void {
  assertNotDecoySession();
  if (vaultStore.getSnapshot().status !== "unlocked") {
    throw new Error("vault_locked");
  }
}

/**
 * An item this tool just saved, read back as the store holds it. The save is
 * the authority; anything else reaches an item through `reachedItem`.
 */
export function findSavedItem(itemId: string): VaultItem {
  const item = vaultStore
    .getSnapshot()
    .items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`item_not_found:${itemId}`);
  return item;
}

/** The item named `I`, given proof the actor's share reach covers it. */
export function findItem<I>(
  itemId: Named<I, string>,
  _reach: ItemReadReach<I> | ItemWriteReach<I>,
): VaultItem {
  return findSavedItem(itemId.value);
}

/** Reach for an item, when only the yes or no matters (filtering a list). */
export function assertItemReach(
  itemId: string,
  wanted: "read" | "write",
): Promise<void> {
  return name(itemId, async (named) => {
    await (wanted === "read" ? reachItemRead(named) : reachItemWrite(named));
  });
}

/**
 * The item, and only after the actor's share reach for it passed. Reach is
 * checked before the lookup, so a missing id and an unshared one refuse alike.
 */
export function reachedItem(
  itemId: string,
  wanted: "read" | "write",
): Promise<VaultItem> {
  const check = vaultStore.pinContinuation();
  return name(itemId, async (named) => {
    const reach = await (wanted === "read"
      ? reachItemRead(named)
      : reachItemWrite(named));
    check();
    return findItem(named, reach);
  });
}

export function ceremonyOpened(location: string) {
  webmcpNavigationSeam.navigate(location);
  return { status: "ceremony_opened", location } as const;
}

/** Await a read without admitting a successor session to its result. */
export async function continueToolRead<T>(
  read: () => Promise<T>,
  ceiling?: () => void,
): Promise<T> {
  const check = pinToolContinuation(ceiling);
  try {
    const result = await read();
    check();
    return result;
  } catch (error) {
    check();
    throw error;
  }
}

/** A caller can impose an extra ceiling, never replace store admission. */
export function pinToolContinuation(ceiling?: () => void): () => void {
  const check = vaultStore.pinContinuation();
  return () => {
    check();
    ceiling?.();
  };
}
