/**
 * Merging two copies of one item field by field (ADR 0144 §merge).
 *
 * Each copy records when each of its fields last changed (`fieldTimes`,
 * written by `stamps.ts`). For every field the copy that changed it later
 * wins, so a username changed on one device and a note changed on another
 * both survive. A typed item's values and an item's custom fields merge one
 * value and one custom field at a time; one removed later than the other side
 * changed it stays removed.
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
  ITEM_META_KEYS,
  asJson,
  customFieldKey,
  fieldsById,
  json,
  recordOf,
  valueKey,
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

function mergeValues(base: Side, other: Side): JsonObject {
  const ours = recordOf(base.item.values);
  const theirs = recordOf(other.item.values);
  const out: MutableJsonObject = {};
  for (const name of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const value = pick(base, other, valueKey(name), ours[name], theirs[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function mergeCustomFields(base: Side, other: Side): JsonValue[] {
  const ours = fieldsById(base.item.fields);
  const theirs = fieldsById(other.item.fields);
  // The base's order, then fields only the other side added, in its order.
  const order =
    timeOf(other, "fields") > timeOf(base, "fields")
      ? [...theirs.keys(), ...ours.keys()]
      : [...ours.keys(), ...theirs.keys()];
  const out: JsonValue[] = [];
  for (const id of new Set(order)) {
    const value = pick(
      base,
      other,
      customFieldKey(id),
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
    const value =
      key === "values"
        ? mergeValues(base, other)
        : key === "fields"
          ? mergeCustomFields(base, other)
          : pick(base, other, key, base.item[key], other.item[key]);
    if (value !== undefined) out[key] = value;
  }
  out.updatedAt =
    winner.updatedAt > loser.updatedAt ? winner.updatedAt : loser.updatedAt;
  out.fieldTimes = laterTimes(base, other);
  return overlapCast(out);
}
