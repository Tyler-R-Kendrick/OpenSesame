/**
 * `ItemReadReach<I>` / `ItemWriteReach<I>` — the current actor's shares (or
 * operator role) let them read, or write, the item named `I` (ADR 0177).
 *
 * The WebMCP vault tools used to run a void `assertItemReach(id, wanted)` and
 * then look the item up with a separate, unguarded `findItem(id)`, so the
 * order — reach first, so an unshared actor cannot tell which ids exist — was
 * a convention each tool had to remember. The lookup now takes this proof
 * about the same named id, so the item cannot be had without passing the
 * check, and a read proof does not stand in for a write.
 *
 * The check itself is `assertShareReach`, unchanged: the same
 * `share_grant_denied` refusal, against the vault that is active when it runs.
 */

import { type Named, type Proof, defineProof } from "@gdp-ts/core";
import { vaultStore } from "../vault/store.js";

const ItemReadReachProver = defineProof("ItemReadReach");
const ItemWriteReachProver = defineProof("ItemWriteReach");

/** The actor may read item `I`. */
export interface ItemReadReach<I> extends Proof<"ItemReadReach", [I]> {}

/** The actor may write item `I`. Reading is a different proof. */
export interface ItemWriteReach<I> extends Proof<"ItemWriteReach", [I]> {}

async function checkReach(
  itemId: string,
  wanted: "read" | "write",
): Promise<void> {
  const { assertShareReach } = await import("../local-share-reach.js");
  await assertShareReach(
    vaultStore.activeTomb(),
    { kind: "item", id: itemId },
    wanted,
  );
}

/** Check read reach for one item and return the proof; a refusal throws. */
export async function reachItemRead<I>(
  itemId: Named<I, string>,
): Promise<ItemReadReach<I>> {
  await checkReach(itemId.value, "read");
  return ItemReadReachProver.prove(itemId);
}

/** Check write reach for one item and return the proof; a refusal throws. */
export async function reachItemWrite<I>(
  itemId: Named<I, string>,
): Promise<ItemWriteReach<I>> {
  await checkReach(itemId.value, "write");
  return ItemWriteReachProver.prove(itemId);
}
