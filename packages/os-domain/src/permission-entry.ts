/**
 * Correlated permissions on the identity plane.
 *
 * Authority used to travel as two independent lists — `actions` and
 * `resources` — checked independently. Two independent lists *are* a cross
 * product, so an issuer who approved "read A and write B" was enforcing "read
 * or write, on A or B", and `write A` came free. The console showed the first
 * reading and the host enforced the second.
 *
 * This is the same algebra the host plane enforces in
 * `crates/domain/src/permission/`, with the same wire encoding, so a consent
 * echo, an approval prompt and a receipt can be compared across the two planes
 * without either side re-deriving what the other meant.
 *
 * Flat to correlated is exact and needs no guessing: the flat form *means* the
 * full product, so `permissionSetFromFlat` produces one entry holding both
 * lists. The reverse is partial, and that is the point — `flattenLossless`
 * refuses rather than hand out the pair the union would have gained.
 */

import { DomainError } from "./errors.js";
import {
  type ResourceScope,
  encodeResourceScope,
  hasControlCharacter,
  parseResourceScope,
  refuse,
  scopeContains,
  scopeMatches,
} from "./permission-scope.js";

/** Most actions one entry may name. */
export const MAX_ENTRY_ACTIONS = 64;
/** Most resource selectors one entry may name. */
export const MAX_ENTRY_RESOURCES = 256;
/** Most entries one set may hold. */
export const MAX_SET_ENTRIES = 64;

/**
 * One correlated block of authority: these actions, on these resources.
 *
 * An entry is a cross product *on purpose* and says so. A caller who wants two
 * uncorrelated pairs writes two entries, and every check has to find both
 * halves of a pair inside a single entry.
 */
export interface PermissionEntry {
  readonly actions: readonly string[];
  readonly resources: readonly ResourceScope[];
}

/** Several correlated entries. */
export interface PermissionSet {
  readonly entries: readonly PermissionEntry[];
}

/** A flat `(actions, resources)` pair, as a two-list record carries it. */
export interface FlatPermissions {
  readonly actions: readonly string[];
  readonly resources: readonly string[];
}

function byKeyAscending(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function canonicalActions(actions: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const action of actions) {
    if (action.length === 0) refuse("permission entry", "has an empty action");
    if (action.trim() !== action || hasControlCharacter(action)) {
      refuse(
        "permission entry",
        `action ${JSON.stringify(action)} is not a bare name`,
      );
    }
    seen.add(action);
  }
  return [...seen].sort();
}

function canonicalScopes(resources: readonly string[]): ResourceScope[] {
  const byEncoding = new Map<string, ResourceScope>();
  for (const pattern of resources) {
    const scope = parseResourceScope(pattern);
    byEncoding.set(encodeResourceScope(scope), scope);
  }
  return [...byEncoding.entries()]
    .sort(([left], [right]) => byKeyAscending(left, right))
    .map(([, scope]) => scope);
}

/**
 * Build an entry, validating both sides.
 *
 * An empty side throws rather than meaning "nothing": the two readings differ
 * by everything, and a request that produced no resources is a request that
 * failed to say what it was for.
 */
export function permissionEntry(
  actions: readonly string[],
  resources: readonly string[],
): PermissionEntry {
  if (actions.length === 0) refuse("permission entry", "names no actions");
  if (actions.length > MAX_ENTRY_ACTIONS) {
    refuse("permission entry", `names more than ${MAX_ENTRY_ACTIONS} actions`);
  }
  if (resources.length === 0) refuse("permission entry", "names no resources");
  if (resources.length > MAX_ENTRY_RESOURCES) {
    refuse(
      "permission entry",
      `names more than ${MAX_ENTRY_RESOURCES} resources`,
    );
  }
  return {
    actions: canonicalActions(actions),
    resources: canonicalScopes(resources),
  };
}

/** The selector strings, in the flat wire encoding. */
export function entryResourcePatterns(entry: PermissionEntry): string[] {
  return entry.resources.map(encodeResourceScope);
}

/**
 * True when this entry authorizes `action` **on** `resource`.
 *
 * Both halves come from the same entry. That conjunction is the mechanism: it
 * is not expressible as "some entry allows the action" and "some entry allows
 * the resource", which is the pair of checks this replaces.
 */
export function entryPermits(
  entry: PermissionEntry,
  action: string,
  resource: string,
): boolean {
  return (
    entry.actions.includes(action) &&
    entry.resources.some((scope) => scopeMatches(scope, resource))
  );
}

/**
 * True when every pair `child` authorizes is authorized by `parent`.
 *
 * Entry to entry, deliberately. Letting a child draw its actions from one
 * parent entry and its resources from another would rebuild the cross product
 * that entries exist to prevent.
 */
export function entryContains(
  parent: PermissionEntry,
  child: PermissionEntry,
): boolean {
  return (
    child.actions.every((action) => parent.actions.includes(action)) &&
    child.resources.every((scope) =>
      parent.resources.some((mine) => scopeContains(mine, scope)),
    )
  );
}

function entryKey(entry: PermissionEntry): string {
  return JSON.stringify([entry.actions, entryResourcePatterns(entry)]);
}

/** Build a set, canonicalizing entry order so order is never authority. */
export function permissionSet(
  entries: readonly PermissionEntry[],
): PermissionSet {
  if (entries.length > MAX_SET_ENTRIES) {
    refuse("permission set", `holds more than ${MAX_SET_ENTRIES} entries`);
  }
  const byKey = new Map<string, PermissionEntry>();
  for (const entry of entries) byKey.set(entryKey(entry), entry);
  return {
    entries: [...byKey.entries()]
      .sort(([left], [right]) => byKeyAscending(left, right))
      .map(([, entry]) => entry),
  };
}

/** An empty set. Authorizes nothing. */
export function emptyPermissionSet(): PermissionSet {
  return { entries: [] };
}

/**
 * The faithful reading of a flat pair: one entry, holding both lists.
 *
 * No guessing. The flat form means the full product — that is what two
 * independent checks enforced — and it carries no information from which a
 * narrower pairing could be inferred. Inventing one would silently narrow
 * authority somebody is relying on.
 */
export function permissionSetFromFlat(
  actions: readonly string[],
  resources: readonly string[],
): PermissionSet {
  return { entries: [permissionEntry(actions, resources)] };
}

/** True when some single entry authorizes `action` on `resource`. */
export function setPermits(
  set: PermissionSet,
  action: string,
  resource: string,
): boolean {
  return set.entries.some((entry) => entryPermits(entry, action, resource));
}

/**
 * True when every pair `child` authorizes is authorized by `parent`.
 *
 * Each child entry must fit inside one parent entry. A child that needed two
 * parent entries to justify itself is claiming a pair that exists in neither.
 */
export function setAttenuates(
  child: PermissionSet,
  parent: PermissionSet,
): boolean {
  return child.entries.every((entry) =>
    parent.entries.some((allowed) => entryContains(allowed, entry)),
  );
}

/** Every action any entry names. A projection: on its own it permits more. */
export function projectedActions(set: PermissionSet): string[] {
  return [
    ...new Set(set.entries.flatMap((entry) => [...entry.actions])),
  ].sort();
}

/** Every selector any entry names. Same caveat. */
export function projectedResources(set: PermissionSet): string[] {
  return [
    ...new Set(set.entries.flatMap((entry) => entryResourcePatterns(entry))),
  ].sort();
}

/**
 * The flat pair — only when it means the same thing.
 *
 * Throws, naming the pair the flat form would have gained. This is the guard
 * on every write into a two-list authority record: a caller holding correlated
 * authority either flattens losslessly or stops.
 */
export function flattenLossless(set: PermissionSet): FlatPermissions {
  const actions = projectedActions(set);
  const resources = projectedResources(set);
  for (const action of actions) {
    for (const pattern of resources) {
      const scope = parseResourceScope(pattern);
      const covered = set.entries.some(
        (entry) =>
          entry.actions.includes(action) &&
          entry.resources.some((mine) => scopeContains(mine, scope)),
      );
      if (!covered) {
        throw new DomainError(
          "INVARIANT_VIOLATION",
          `flattening would authorize a pair nobody granted: ${action} on ${pattern}`,
          { action, resource: pattern },
        );
      }
    }
  }
  return { actions, resources };
}

/**
 * One flat pair per entry — the honest way to put correlated authority into a
 * record that only has two lists.
 */
export function splitFlat(set: PermissionSet): FlatPermissions[] {
  return set.entries.map((entry) => ({
    actions: entry.actions,
    resources: entryResourcePatterns(entry),
  }));
}
