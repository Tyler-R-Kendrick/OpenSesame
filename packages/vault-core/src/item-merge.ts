/**
 * Merging two copies of one item field by field (ADR 0144 §merge).
 *
 * Each copy records when each of its fields last changed (`fieldTimes`,
 * written by `stamps.ts`). For every field the copy that changed it later
 * wins, so a username changed on one device and a note changed on another
 * both survive. A typed item's values and an item's custom fields merge one
 * value and one custom field at a time, and an account's login methods one
 * method at a time; one removed later than the other side changed it stays
 * removed.
 *
 * Deterministic either way round: the whole copy that changed last is the
 * base, a field time decides each field, and a tie goes to the base. Two
 * copies with no field times at all (written before this) fall back to the
 * whole-item rule, the newer copy winning outright.
 */
import {
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { VaultItem } from "./model.js";
import {
  ID_LIST_KEYS,
  ITEM_META_KEYS,
  NAMED_RECORD_KEYS,
  asJson,
  fieldsById,
  json,
  listEntryKey,
  recordOf,
} from "./stamps.js";
import type { FieldTimes, FieldTimesDraft } from "./sync-model.js";

/** When an item last changed, a trash counting as a change. */
export function changedAt(item: VaultItem): string {
  return item.deletedAt && item.deletedAt > item.updatedAt
    ? item.deletedAt
    : item.updatedAt;
}

/** Total order on whole copies: when, then content, so either order agrees. */
export function itemVersion(item: VaultItem): string {
  return `${changedAt(item)}\0${JSON.stringify(item)}`;
}

type Side = { item: JsonObject; times: FieldTimes };

function timeOf(side: Side, key: string): string {
  return side.times[key] ?? "";
}

/** The other side's value only when it changed `key` strictly later. */
function pick(
  base: Side,
  other: Side,
  key: string,
  ours: JsonValue | undefined,
  theirs: JsonValue | undefined,
): JsonValue | undefined {
  return timeOf(other, key) > timeOf(base, key) ? theirs : ours;
}

/** A record of named entries (`values`, `environments`), one entry at a time. */
function mergeNamed(
  base: Side,
  other: Side,
  field: string,
  keyOf: (name: string) => string,
): JsonObject {
  const ours = recordOf(base.item[field]);
  const theirs = recordOf(other.item[field]);
  const out: MutableJsonObject = {};
  for (const name of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const value = pick(base, other, keyOf(name), ours[name], theirs[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function mergeIdList(base: Side, other: Side, list: string): JsonValue[] {
  const ours = fieldsById(base.item[list]);
  const theirs = fieldsById(other.item[list]);
  // The base's order, then records only the other side added, in its order.
  const order =
    timeOf(other, list) > timeOf(base, list)
      ? [...theirs.keys(), ...ours.keys()]
      : [...ours.keys(), ...theirs.keys()];
  const out: JsonValue[] = [];
  for (const id of new Set(order)) {
    const value = pick(
      base,
      other,
      listEntryKey(list, id),
      ours.get(id),
      theirs.get(id),
    );
    if (value !== undefined) out.push(value);
  }
  return out;
}

function laterTimes(a: Side, b: Side): FieldTimesDraft {
  const out: FieldTimesDraft = { ...a.times };
  for (const [key, at] of Object.entries(b.times)) {
    if (!out[key] || at > out[key]) out[key] = at;
  }
  return out;
}

/**
 * What one key of the merged item holds: a named record entry by entry, a list
 * of records by id, anything else from the copy that changed it later. Nothing
 * means the key is left out.
 */
function mergeKey(base: Side, other: Side, key: string): JsonValue | undefined {
  const nameKey = NAMED_RECORD_KEYS.get(key);
  if (nameKey) {
    const merged = mergeNamed(base, other, key, nameKey);
    // The copy that changed last has no such record, and no entry of the
    // other's outlived that: an item taken out of the schema stays out.
    return !(key in base.item) && Object.keys(merged).length === 0
      ? undefined
      : merged;
  }
  return ID_LIST_KEYS.has(key)
    ? mergeIdList(base, other, key)
    : pick(base, other, key, base.item[key], other.item[key]);
}

/** One item from two copies of it. */
export function mergeItem(left: VaultItem, right: VaultItem): VaultItem {
  const [winner, loser] =
    itemVersion(right) > itemVersion(left) ? [right, left] : [left, right];
  if (
    json(asJson(winner)) === json(asJson(loser)) ||
    winner.kind !== loser.kind ||
    (!winner.fieldTimes && !loser.fieldTimes)
  ) {
    return winner;
  }
  const base: Side = { item: asJson(winner), times: winner.fieldTimes ?? {} };
  const other: Side = { item: asJson(loser), times: loser.fieldTimes ?? {} };
  const out: MutableJsonObject = {};
  const keys = new Set([...Object.keys(base.item), ...Object.keys(other.item)]);
  for (const key of keys) {
    if (ITEM_META_KEYS.has(key)) {
      out[key] = base.item[key];
      continue;
    }
    const value = mergeKey(base, other, key);
    if (value !== undefined) out[key] = value;
  }
  out.updatedAt =
    winner.updatedAt > loser.updatedAt ? winner.updatedAt : loser.updatedAt;
  out.fieldTimes = laterTimes(base, other);
  return overlapCast(out);
}
