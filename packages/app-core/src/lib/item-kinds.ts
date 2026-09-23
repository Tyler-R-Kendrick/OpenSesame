/**
 * Which item kinds a person may *create* here (SURFACE-08).
 *
 * The core vault owns logins, cards, secrets and notes. Every other kind —
 * passkey records, certificates, drops — is an `item-kind` contribution from
 * the capability that owns it, so its creation surfaces (the rail filter, the
 * type picker, the filtered "+ new") exist only while that capability is in
 * the plan. Existing records of an excluded kind still render: the parsers
 * are untouched and the unknown-type fallback is the same one a community
 * type uses.
 */

import { KIND_LABEL } from "@opensesame/vault-core";
import type { ItemKindContribution } from "./capabilities/runtime-contract.js";
import { contributionsSnapshot } from "./contributions.js";

export type ItemKindRow = Readonly<{
  /** The item type id, also the `?f=` filter value. */
  id: string;
  /** The rail's directory name under `vault/`. */
  segment: string;
  label: string;
  order: number;
}>;

/**
 * The kinds the core vault ships. Orders leave the gaps the contributed
 * kinds fill (passkeys 20, drops 50, certificates 70), so the rail reads
 * logins, passkeys, cards, secrets, drops, notes, certs whatever is present.
 */
export const CORE_ITEM_KINDS: readonly ItemKindRow[] = [
  { id: "login", segment: "logins", label: "Login", order: 0 },
  { id: "card", segment: "cards", label: "Card", order: 30 },
  { id: "secret", segment: "secrets", label: "Secret", order: 40 },
  { id: "note", segment: "notes", label: "Secure note", order: 60 },
];

export function itemKindsFrom(
  contributions: readonly ItemKindContribution[],
): readonly ItemKindRow[] {
  const contributed = contributions
    .filter((entry) => !CORE_ITEM_KINDS.some((core) => core.id === entry.kind))
    .map((entry) => ({
      id: entry.kind,
      segment: entry.segment,
      label: entry.label,
      order: entry.order,
    }));
  return [...CORE_ITEM_KINDS, ...contributed].sort((left, right) =>
    left.order !== right.order
      ? left.order - right.order
      : left.id.localeCompare(right.id),
  );
}

/** Core kinds plus the approved `item-kind` contributions, sorted. */
export function itemKindsSnapshot(): readonly ItemKindRow[] {
  return itemKindsFrom(contributionsSnapshot("item-kind"));
}

/**
 * The built-in kinds a capability owns. A community type (ADR 0087) is not
 * among them: it is the core vault's own plugin mechanism and stays creatable.
 */
const GATED_KINDS: ReadonlySet<string> = new Set(
  Object.keys(KIND_LABEL).filter((kind) => kind !== "typed"),
);

/** Whether a creation surface may offer `kind` on this installation. */
export function isCreatableItemKind(kind: string): boolean {
  if (!GATED_KINDS.has(kind)) return true;
  return itemKindsSnapshot().some((row) => row.id === kind);
}
