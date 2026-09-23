/**
 * What a marketplace offer means on this device (ADR 0134): the state a row
 * shows and whether its one action installs, updates, or is withheld. The
 * registry is the only authority — this reads it, and the install itself
 * goes through the same `installItemTypeDefinition` a pasted definition does,
 * so every refusal ADR 0087 §5 names still applies.
 */

import {
  type ItemTypeDefinition,
  type ItemTypeRegistry,
  compareVersions,
  describeErrors,
} from "@opensesame/vault-item-types";
import type { MarketplaceOffer } from "../../lib/item-type-marketplace/load.js";

export type OfferState =
  | { readonly kind: "available" }
  | { readonly kind: "installed"; readonly version: string }
  | { readonly kind: "update"; readonly from: string }
  | { readonly kind: "builtin" }
  | { readonly kind: "conflict"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

function publisherConflict(
  current: ItemTypeDefinition,
  offered: ItemTypeDefinition,
): OfferState | undefined {
  if (current.metadata.publisher === offered.metadata.publisher)
    return undefined;
  return {
    kind: "conflict",
    reason: `Installed from ${publisherLabel(current.metadata.publisher)}`,
  };
}

/**
 * Where an offer stands. The registry decides: `check` answers exactly what
 * an install would, so a row never offers an install or an update that the
 * registry then refuses — a clashing title, extension or vault directory
 * included, on an update as much as a first install.
 */
export function offerState(
  registry: ItemTypeRegistry,
  offer: MarketplaceOffer,
): OfferState {
  if (!offer.ok) return { kind: "invalid", reason: offer.problem };
  const definition = offer.definition;
  const id = definition.metadata.id;
  if (registry.isBuiltin(id)) return { kind: "builtin" };
  const current = registry.get(id);
  if (current !== undefined) {
    const publisher = publisherConflict(current, definition);
    if (publisher !== undefined) return publisher;
    const newer =
      compareVersions(definition.metadata.version, current.metadata.version) >
      0;
    if (!newer) return { kind: "installed", version: current.metadata.version };
  }
  const checked = registry.check(offer.text);
  if (!checked.ok)
    return { kind: "conflict", reason: describeErrors(checked.errors) };
  return current === undefined
    ? { kind: "available" }
    : { kind: "update", from: current.metadata.version };
}

/** The sentence a row's status glyph carries. */
export function offerStateLabel(state: OfferState): string {
  switch (state.kind) {
    case "available":
      return "Not installed";
    case "installed":
      return `Installed, ${state.version}`;
    case "update":
      return `Update from ${state.from}`;
    case "builtin":
      return "Built in";
    case "conflict":
    case "invalid":
      return state.reason;
  }
}

/** A publisher is an https URL; a row names its host. */
export function publisherLabel(publisher: string): string {
  try {
    return new URL(publisher).host || publisher;
  } catch {
    return publisher;
  }
}

/** Updates first, so what needs a person is never scrolled past. */
export function offerRank(state: OfferState): number {
  const order: Record<OfferState["kind"], number> = {
    update: 0,
    available: 1,
    installed: 2,
    conflict: 3,
    builtin: 4,
    invalid: 5,
  };
  return order[state.kind];
}
