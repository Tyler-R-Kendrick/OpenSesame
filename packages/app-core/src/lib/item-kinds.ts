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

import {
  KIND_LABEL,
  itemTypeRegistry,
  typeLabel,
} from "@opensesame/vault-core";
import {
  RESERVED_DIRECTORIES,
  RESERVED_TYPE_IDS,
  directoryName,
} from "@opensesame/vault-item-types";
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

/**
 * The built-in kinds a capability owns. A community type (ADR 0087) is not
 * among them: it is the core vault's own plugin mechanism and stays creatable.
 */
const GATED_KINDS: ReadonlySet<string> = new Set(
  Object.keys(KIND_LABEL).filter((kind) => kind !== "typed"),
);

/** Type directories sort after every platform kind (certs is 70). */
const TYPE_DIRECTORY_ORDER = 100;

/**
 * One vault directory per item type (ADR 0087). After the platform kinds
 * come every installed type — installing one is what makes its directory, so
 * it shows before it holds an item — and then any other type the vault holds
 * items of (a built-in with no platform kind, a type installed on another
 * device and not here), so no item is left without a directory. A kind a
 * capability owns never comes back this way: without the capability it has
 * no directory, only the records (SURFACE-08).
 *
 * The registry refuses an install whose directory is taken, so a registered
 * type always gets its own name; only a type not installed here, named by its
 * bare id, can meet a taken one, and it is numbered rather than merged. An id
 * that is also a filter (`trash`) gets no directory at all: its link would
 * open the filter. Its items stay under `all`.
 */
export function withTypeDirectories(
  rows: readonly ItemKindRow[],
  present: Iterable<string> = [],
): readonly ItemKindRow[] {
  const registry = itemTypeRegistry();
  const ids = new Set(rows.map((row) => row.id));
  const taken = new Set([
    ...RESERVED_DIRECTORIES,
    ...rows.map((row) => row.segment),
  ]);
  const wanted = new Set(
    registry
      .list()
      .filter(({ source }) => source !== "builtin")
      .map(({ definition }) => definition.metadata.id),
  );
  for (const id of present) {
    if (GATED_KINDS.has(id) || id === "typed") continue;
    if (!RESERVED_TYPE_IDS.includes(id)) wanted.add(id);
  }
  const added = [...wanted]
    .filter((id) => !ids.has(id))
    .map((id) => {
      const definition = registry.get(id);
      return {
        id,
        name: definition === undefined ? id : directoryName(definition),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const directories: ItemKindRow[] = [];
  for (const { id, name } of added) {
    let segment = name;
    for (let n = 2; taken.has(segment); n += 1) segment = `${name}-${n}`;
    taken.add(segment);
    directories.push({
      id,
      segment,
      label: typeLabel(id),
      order: TYPE_DIRECTORY_ORDER + directories.length,
    });
  }
  return [...rows, ...directories];
}

/**
 * Core kinds, the approved `item-kind` contributions and every installed
 * type, sorted. The rail adds the types its items hold on top of this.
 */
export function itemKindsSnapshot(): readonly ItemKindRow[] {
  return withTypeDirectories(itemKindsFrom(contributionsSnapshot("item-kind")));
}

/** Whether a creation surface may offer `kind` on this installation. */
export function isCreatableItemKind(kind: string): boolean {
  if (!GATED_KINDS.has(kind)) return true;
  return itemKindsSnapshot().some((row) => row.id === kind);
}
