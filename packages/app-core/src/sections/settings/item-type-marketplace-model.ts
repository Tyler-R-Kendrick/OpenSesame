/**
 * What a marketplace offer means on this device (ADR 0134): the state a row
 * shows and whether its one action installs, updates, or is withheld. The
 * registry is the only authority — this reads it, and the install itself
 * goes through the same `installItemTypeDefinition` a pasted definition does,
 * so every refusal ADR 0087 §5 names still applies.
 */

import type {
  ItemTypeDefinition,
  ItemTypeRegistry,
} from "@opensesame/vault-item-types";
import type { MarketplaceOffer } from "../../lib/item-type-marketplace/load.js";

export type OfferState =
  | { readonly kind: "available" }
  | { readonly kind: "installed"; readonly version: string }
  | { readonly kind: "update"; readonly from: string }
  | { readonly kind: "builtin" }
  | { readonly kind: "conflict"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

function compareVersions(left: string, right: string): number {
  const l = left.split(".").map(Number);
  const r = right.split(".").map(Number);
  for (let at = 0; at < 3; at += 1) {
    const a = l[at] ?? 0;
    const b = r[at] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function extensionOwner(
  registry: ItemTypeRegistry,
  definition: ItemTypeDefinition,
): string | undefined {
  const own = definition.metadata.id;
  return registry
    .list()
    .find(
      ({ definition: other }) =>
        other.metadata.id !== own &&
        other.spec.extension === definition.spec.extension,
    )?.definition.spec.title;
}

function installedState(
  current: ItemTypeDefinition,
  offered: ItemTypeDefinition,
): OfferState {
  if (current.metadata.publisher !== offered.metadata.publisher)
    return {
      kind: "conflict",
      reason: `Installed from ${publisherLabel(current.metadata.publisher)}`,
    };
  return compareVersions(offered.metadata.version, current.metadata.version) > 0
    ? { kind: "update", from: current.metadata.version }
    : { kind: "installed", version: current.metadata.version };
}

export function offerState(
  registry: ItemTypeRegistry,
  offer: MarketplaceOffer,
): OfferState {
  if (!offer.ok) return { kind: "invalid", reason: offer.problem };
  const definition = offer.definition;
  const id = definition.metadata.id;
  if (registry.isBuiltin(id)) return { kind: "builtin" };
  const current = registry.get(id);
  if (current !== undefined) return installedState(current, definition);
  const clash = extensionOwner(registry, definition);
  if (clash !== undefined)
    return {
      kind: "conflict",
      reason: `${definition.spec.extension} is already ${clash}`,
    };
  return { kind: "available" };
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
