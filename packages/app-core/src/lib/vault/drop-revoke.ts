/**
 * Sender-side revocation for drop claim sessions (persona must-fix #1).
 * Device-local claims only — a hosted Identity revoke route is out of scope.
 * A missing claim is not a failure: trash and purge must still finish, and a
 * synced drop may live on the device that sealed it.
 */

import {
  type VaultBody,
  type VaultItem,
  boundCredentials,
} from "@opensesame/vault-core";
import {
  emptyTrash,
  expireDropClaims,
  purgeItem,
  trashItem,
} from "./body-edits.js";
import {
  LocalDropClaimError,
  type LocalDropRevocation,
} from "./local-drop-claims.js";
import {
  revokeOutboundDrop,
  revokeOutboundLinkedToItem,
} from "./outbound-drops.js";

export type DiscardKind = "trash" | "purge" | "empty";

type Mutate = (change: (body: VaultBody) => void) => Promise<void>;

export function itemsRemovedWithTrash(
  items: readonly VaultItem[],
  id: string,
): VaultItem[] {
  const root = items.find((item) => item.id === id);
  if (!root || root.deletedAt !== null) return [];
  const alongside = new Set(boundCredentials(items, id).map((item) => item.id));
  return items.filter(
    (item) =>
      item.deletedAt === null && (item.id === id || alongside.has(item.id)),
  );
}

export function itemsRemovedWithPurge(
  items: readonly VaultItem[],
  id: string,
): VaultItem[] {
  const ids = new Set([id]);
  for (const item of items) {
    if (item.kind === "credential" && item.accountId === id) ids.add(item.id);
  }
  return items.filter((item) => ids.has(item.id));
}

async function revokeQuiet(
  claimId: string,
  bearerToken: string,
): Promise<LocalDropRevocation> {
  try {
    return await revokeOutboundDrop(claimId, bearerToken);
  } catch (error) {
    if (error instanceof LocalDropClaimError) return "missing";
    throw error;
  }
}

/** Claim ids killed on this device. Already-opened and missing claims are not. */
export async function revokeSharesLeavingVault(
  items: readonly VaultItem[],
): Promise<readonly string[]> {
  const killed: string[] = [];
  for (const item of items) {
    if (item.kind === "drop" && item.claimId && item.bearerToken) {
      const outcome = await revokeQuiet(item.claimId, item.bearerToken);
      if (outcome === "revoked") killed.push(item.claimId);
    }
    for (const claimId of await revokeOutboundLinkedToItem(item.id)) {
      if (!killed.includes(claimId)) killed.push(claimId);
    }
  }
  return killed;
}

async function markRevokedDrops(
  leaving: readonly VaultItem[],
  killed: readonly string[],
  mutate: Mutate,
): Promise<void> {
  if (killed.length === 0) return;
  const doomed = new Set(killed);
  const stillThere = leaving.some(
    (item) =>
      item.kind === "drop" &&
      item.state === "pending" &&
      item.deletedAt === null &&
      doomed.has(item.claimId),
  );
  if (!stillThere) return;
  await mutate((body) => expireDropClaims(body, doomed));
}

/**
 * Edit the vault, then kill sends that left with those items. Revoke runs
 * after the edit so a failed seal does not burn a live link.
 */
export async function commitDiscard(
  kind: DiscardKind,
  items: readonly VaultItem[],
  id: string,
  mutate: Mutate,
): Promise<void> {
  const leaving =
    kind === "trash"
      ? itemsRemovedWithTrash(items, id)
      : kind === "purge"
        ? itemsRemovedWithPurge(items, id)
        : items.filter((item) => item.deletedAt !== null);
  await mutate((body) => {
    if (kind === "trash") trashItem(body, id);
    else if (kind === "purge") purgeItem(body, id);
    else emptyTrash(body);
  });
  const killed = await revokeSharesLeavingVault(leaving);
  if (kind !== "trash") return;
  await markRevokedDrops(leaving, killed, mutate);
}

/** Unlock sweep: a drop trashed on another device is killed when it syncs here. */
export async function revokeTrashedShares(
  items: readonly VaultItem[],
  mutate: Mutate,
): Promise<void> {
  const trashed = items.filter((item) => item.deletedAt !== null);
  const killed = await revokeSharesLeavingVault(trashed);
  const doomed = new Set(killed);
  const pending = trashed.some(
    (item) =>
      item.kind === "drop" &&
      item.state === "pending" &&
      doomed.has(item.claimId),
  );
  if (!pending) return;
  await mutate((body) => expireDropClaims(body, doomed));
}

export async function revokeDropClaim(
  claimId: string,
  bearerToken: string,
): Promise<void> {
  await revokeOutboundDrop(claimId, bearerToken);
}

export async function revokeDropVaultItem(item: VaultItem): Promise<void> {
  await revokeSharesLeavingVault([item]);
}
