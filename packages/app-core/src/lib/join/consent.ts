/**
 * What a person accepts from an offer, item by item (ADR 0044, ADR 0136).
 *
 * The Host refuses a claim that omits a required item or accepts an item
 * without what it depends on; this module makes those states unreachable in
 * the page instead of letting a press find out. The rule the removed
 * ceremony broke is the other half: optional items start **off**. Accepting
 * everything the owner offered, unseen and unchosen, was the default there —
 * least privilege means the person turns on what they want.
 */

import type { JoinOffer } from "./wire.js";

export type Selection = ReadonlySet<string>;

function closure(offer: JoinOffer, seeds: Iterable<string>): Set<string> {
  const byId = new Map(offer.items.map((entry) => [entry.id, entry]));
  const out = new Set<string>();
  const queue = [...seeds];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (out.has(next)) continue;
    out.add(next);
    queue.push(...(byId.get(next)?.dependencies ?? []));
  }
  return out;
}

/** Items that cannot be turned off: the required ones and what they need. */
export function lockedItems(offer: JoinOffer): Selection {
  return closure(
    offer,
    offer.items.filter((entry) => entry.required).map((entry) => entry.id),
  );
}

export function initialSelection(offer: JoinOffer): Selection {
  return lockedItems(offer);
}

/** Everything that (transitively) depends on `target`. */
function dependents(offer: JoinOffer, target: string): Set<string> {
  const out = new Set<string>([target]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of offer.items) {
      if (out.has(entry.id)) continue;
      if (entry.dependencies.some((dep) => out.has(dep))) {
        out.add(entry.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Turn one item on or off. On brings what it depends on; off takes what
 * depends on it. A locked item does not move.
 */
export function toggleItem(
  offer: JoinOffer,
  selection: Selection,
  target: string,
): Selection {
  const locked = lockedItems(offer);
  if (locked.has(target) || !offer.items.some((e) => e.id === target))
    return selection;
  if (!selection.has(target)) return closure(offer, [...selection, target]);
  const drop = dependents(offer, target);
  return new Set(
    [...selection].filter((entry) => locked.has(entry) || !drop.has(entry)),
  );
}

/** The accepted ids in the offer's own order — what the claim names. */
export function acceptedItemIds(
  offer: JoinOffer,
  selection: Selection,
): string[] {
  const whole = closure(offer, [...selection, ...lockedItems(offer)]);
  return offer.items.filter((e) => whole.has(e.id)).map((e) => e.id);
}
