import type { Folder, VaultItem } from "@opensesame/vault-core";
import {
  ItemDepartureError,
  type ItemWithdrawal,
  itemText,
} from "../vault/item-departure.js";
import type { ItemReturn } from "../vault/item-departure.js";
import {
  type TravelDeps,
  type TravelGateRefusal,
  travelGate,
} from "./depart.js";
import {
  type ItemsVaultRef,
  itemsBundleFileName,
  newBundleId,
  openItemsBundle,
  sealItemsBundle,
} from "./items-bundle.js";
import {
  cannotBeHidden,
  digestsOf,
  foldersOf,
  label,
  withBoundCredentials,
} from "./items-depart-parts.js";
import {
  formatReturnCode,
  mintReturnSecret,
  parseReturnCode,
} from "./return-code.js";
import type { TravelStorage } from "./storage.js";

/** A copy the device would hand back, which hiding cannot reach. */
export type ItemsCopy =
  | "backup_target"
  | "history_snapshot"
  | "paired_drive"
  | "offline_queue";

/** The open vault as hiding reads it. */
export type OpenVault = Readonly<
  ItemsVaultRef & {
    items: readonly VaultItem[];
    folders: readonly Folder[];
  }
>;

export type ItemsDeps = Pick<
  TravelDeps,
  "duressActive" | "ownerPresent" | "exclusive" | "now"
> &
  Readonly<{
    storage: Pick<TravelStorage, "durable">;
    vault: () => OpenVault | null;
    /** Item ids a person or agent still holds a share or session grant on. */
    sharedItems: (tomb: string) => Promise<ReadonlySet<string>>;
    copiesInPlay: (tomb: string) => Promise<readonly ItemsCopy[]>;
    withdraw: (plan: ItemWithdrawal) => Promise<void>;
    restore: (back: ItemReturn) => Promise<void>;
    /** Forget what the device keeps about these items, apart from the vault. */
    purge: Readonly<{
      activity: (tomb: string, ids: ReadonlySet<string>) => Promise<number>;
      passwords: (tomb: string, ids: readonly string[]) => Promise<number>;
      offlineCache: (tomb: string) => Promise<void>;
    }>;
  }>;

export type ItemsRefusal =
  | TravelGateRefusal
  | "nothing_chosen"
  | "unknown_item"
  | "item_not_hideable"
  | "item_shared"
  | "copies_in_play"
  | "purge_failed"
  | "self_check_failed";

export type ItemsPackOutcome =
  | { ok: true; pkg: ItemsPackage }
  | {
      ok: false;
      code: ItemsRefusal;
      ids: readonly string[];
      copies: readonly ItemsCopy[];
    };

export type HidingItem = Readonly<{ id: string; label: string; kind: string }>;

export type ItemsPackage = Readonly<{
  bundleId: string;
  bundleJson: string;
  bundleFileName: string;
  /** Shown once. Never written to this device. */
  returnCode: string;
  items: readonly HidingItem[];
  vault: ItemsVaultRef;
  /** What a removal may take: each item as packed, and the folders it may empty. */
  withdrawal: ItemWithdrawal;
}>;

export type ItemsDepartureReceipt = Readonly<{
  hidden: readonly string[];
  /** Folders the items emptied, which left with them. */
  foldersRemoved: number;
  /** Lines and digests dropped from the places that kept them. */
  forgotten: number;
  /** A trace that could not be dropped; empty when the removal held. */
  incomplete: readonly string[];
  completion: "applied_local" | "incomplete";
  assurance: "application_scoped_removal";
}>;

export type ItemsCompleteOutcome =
  | { ok: true; receipt: ItemsDepartureReceipt }
  | {
      ok: false;
      code:
        | ItemsRefusal
        | "not_acknowledged"
        | "changed_since_packed"
        | "vault_changed";
      ids: readonly string[];
      copies: readonly ItemsCopy[];
    };

const NOTHING: readonly string[] = [];
const NO_COPIES: readonly ItemsCopy[] = [];

function refused(
  code: ItemsRefusal,
  ids: readonly string[] = NOTHING,
  copies: readonly ItemsCopy[] = NO_COPIES,
): Extract<ItemsPackOutcome, { ok: false }> {
  return { ok: false, code, ids, copies };
}

/** What stops these items being hidden, before anything is read into a bundle. */
async function whyNot(
  deps: ItemsDeps,
  vault: OpenVault,
  ids: readonly string[],
): Promise<ItemsPackOutcome | null> {
  if (ids.length === 0) return refused("nothing_chosen");
  const byId = new Map(vault.items.map((item) => [item.id, item]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) return refused("unknown_item", unknown);
  const stuck = vault.items
    .filter((item) => ids.includes(item.id) && cannotBeHidden(item))
    .map((item) => item.id);
  if (stuck.length > 0) return refused("item_not_hideable", stuck);
  const shared = await deps.sharedItems(vault.tomb);
  const held = ids.filter((id) => shared.has(id));
  if (held.length > 0) return refused("item_shared", held);
  const copies = await deps.copiesInPlay(vault.tomb);
  if (copies.length > 0) return refused("copies_in_play", NOTHING, copies);
  return null;
}

/** Read, seal and self-check. Removes nothing. */
export async function packItemDeparture(
  deps: ItemsDeps,
  input: { ids: readonly string[] },
): Promise<ItemsPackOutcome> {
  const gate = await travelGate(deps);
  if (gate) return refused(gate);
  const vault = deps.vault();
  if (!vault) return refused("owner_not_present");
  // An account leaves with the credentials bound to it (ADR 0177): left behind
  // they would still be there to open while the account was gone.
  const ids = withBoundCredentials(vault.items, [...new Set(input.ids)]);
  const blocked = await whyNot(deps, vault, ids);
  if (blocked) return blocked;
  const chosen = new Set(ids);
  const items = vault.items.filter((item) => chosen.has(item.id));
  const { named, emptied } = foldersOf(vault, chosen);
  const bundleId = newBundleId();
  const secret = mintReturnSecret();
  const returnCode = await formatReturnCode(secret);
  const vaultRef = { tomb: vault.tomb, createdAt: vault.createdAt };
  const payload = {
    v: 1 as const,
    bundleId,
    hiddenAt: deps.now().toISOString(),
    vault: vaultRef,
    items,
    folders: named,
  };
  const bundleJson = await sealItemsBundle(payload, secret);
  // Prove the round trip before anyone is told the bundle can be relied on:
  // the code as displayed opens it, and it holds what was read.
  try {
    const reopened = await openItemsBundle(
      bundleJson,
      await parseReturnCode(returnCode),
    );
    const [packed, reread] = await Promise.all([
      digestsOf(items),
      digestsOf(reopened.items),
    ]);
    if (JSON.stringify(packed) !== JSON.stringify(reread)) {
      return refused("self_check_failed");
    }
  } catch {
    return refused("self_check_failed");
  }
  return {
    ok: true,
    pkg: {
      bundleId,
      bundleJson,
      bundleFileName: itemsBundleFileName(bundleId),
      returnCode,
      items: items.map((item) => ({
        id: item.id,
        label: label(item),
        kind: item.kind,
      })),
      vault: vaultRef,
      withdrawal: {
        items: Object.fromEntries(items.map((i) => [i.id, itemText(i)])),
        folderIds: emptied,
      },
    },
  };
}

type Traces = { forgotten: number; failed: string[] };

/** Drop what the device keeps beside the vault about these items. */
async function forgetTraces(
  deps: ItemsDeps,
  tomb: string,
  ids: readonly string[],
): Promise<Traces> {
  const traces: Traces = { forgotten: 0, failed: [] };
  const attempt = async (
    name: string,
    run: () => Promise<number | undefined>,
  ) => {
    try {
      traces.forgotten += (await run()) ?? 0;
    } catch {
      traces.failed.push(name);
    }
  };
  await attempt("activity", () => deps.purge.activity(tomb, new Set(ids)));
  await attempt("passwords", () => deps.purge.passwords(tomb, ids));
  await attempt("offline_cache", async () => {
    await deps.purge.offlineCache(tomb);
    return 0;
  });
  return traces;
}

/**
 * Take the packed items out of the open vault, once the person has said the
 * bundle and the return code are both somewhere other than this device.
 */
export function completeItemDeparture(
  deps: ItemsDeps,
  pkg: ItemsPackage,
  ack: { bundleSaved: boolean; codeRecorded: boolean },
): Promise<ItemsCompleteOutcome> {
  if (!ack.bundleSaved || !ack.codeRecorded) {
    return Promise.resolve({
      ok: false,
      code: "not_acknowledged",
      ids: NOTHING,
      copies: NO_COPIES,
    });
  }
  return deps.exclusive(() => withdrawPacked(deps, pkg));
}

async function withdrawPacked(
  deps: ItemsDeps,
  pkg: ItemsPackage,
): Promise<ItemsCompleteOutcome> {
  const gate = await travelGate(deps);
  const vault = deps.vault();
  const fail = (
    code: Extract<ItemsCompleteOutcome, { ok: false }>["code"],
    ids: readonly string[] = NOTHING,
    copies: readonly ItemsCopy[] = NO_COPIES,
  ): ItemsCompleteOutcome => ({ ok: false, code, ids, copies });
  if (gate) return fail(gate);
  if (
    !vault ||
    vault.tomb !== pkg.vault.tomb ||
    vault.createdAt !== pkg.vault.createdAt
  ) {
    return fail("vault_changed");
  }
  const ids = Object.keys(pkg.withdrawal.items);
  // A share or a copy may have appeared while the bundle was on screen.
  const shared = await deps.sharedItems(vault.tomb);
  const held = ids.filter((id) => shared.has(id));
  if (held.length > 0) return fail("item_shared", held);
  const copies = await deps.copiesInPlay(vault.tomb);
  if (copies.length > 0) return fail("copies_in_play", NOTHING, copies);
  // Before: a trace dropped for an item that then stays is only a lost line.
  // A purge that fails here stops the removal with nothing yet taken.
  const before = await forgetTraces(deps, vault.tomb, ids);
  if (before.failed.length > 0) return fail("purge_failed");
  const emptiedBefore = vault.folders.length;
  try {
    await deps.withdraw(pkg.withdrawal);
  } catch (error) {
    if (error instanceof ItemDepartureError) {
      return fail("changed_since_packed", error.ids);
    }
    throw error;
  }
  // After: a line written while the items were leaving is dropped too.
  const after = await forgetTraces(deps, vault.tomb, ids);
  const left = deps.vault();
  return {
    ok: true,
    receipt: {
      hidden: ids,
      foldersRemoved: Math.max(0, emptiedBefore - (left?.folders.length ?? 0)),
      forgotten: before.forgotten + after.forgotten,
      incomplete: after.failed,
      completion: after.failed.length === 0 ? "applied_local" : "incomplete",
      assurance: "application_scoped_removal",
    },
  };
}

export { cannotBeHidden } from "./items-depart-parts.js";
