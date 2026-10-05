/**
 * Change times that survive a wrong clock (ADR 0144 §merge).
 *
 * A merge keeps the newer of two copies by time, so a device whose clock runs
 * behind would lose its own edits to an older one it had already seen. Every
 * edit is therefore stamped after everything its body already records — the
 * wall clock, or one millisecond past the latest time seen, whichever is later
 * (a hybrid logical clock). An edit made after a device saw another's change
 * always wins over it; only edits neither device had seen are ordered by the
 * clocks alone.
 *
 * The stamp is applied after the edit, by comparing the body before and after
 * it, so no write path has to remember to do it. Each changed item also
 * records which of its fields changed when (`fieldTimes`), which is what lets
 * two devices' edits to different fields of one item both survive a merge.
 */
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { Folder, VaultBody, VaultItem, VaultTombstones } from "./model.js";
import type { FieldTimesDraft } from "./sync-model.js";

/** Item keys that are bookkeeping, never merged as a field. */
export const ITEM_META_KEYS: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "createdAt",
  "updatedAt",
  "fieldTimes",
]);

/** Field keys a field time is recorded under: a property, a typed value, a custom field. */
export function valueKey(name: string): string {
  return `values.${name}`;
}
export function customFieldKey(id: string): string {
  return `fields.${id}`;
}

function later(a: string, b: string | null | undefined): string {
  return b && b > a ? b : a;
}

/** The latest time a body records anywhere. */
export function latestStamp(body: VaultBody): string {
  let seen = "";
  for (const item of body.items) {
    seen = later(
      later(later(seen, item.updatedAt), item.deletedAt),
      item.createdAt,
    );
    for (const at of Object.values(item.fieldTimes ?? {}))
      seen = later(seen, at);
  }
  for (const folder of body.folders) {
    seen = later(later(seen, folder.createdAt), folder.updatedAt);
  }
  for (const kind of Object.values(body.tombstones ?? {})) {
    for (const at of Object.values(kind ?? {})) seen = later(seen, at);
  }
  for (const at of Object.values(body.itemTypesAt ?? {}))
    seen = later(seen, at);
  return seen;
}

/** The wall clock, or one millisecond after `seen` when the clock is not past it. */
export function stampAfter(seen: string, now: Date = new Date()): string {
  const wall = now.toISOString();
  if (!seen || wall > seen) return wall;
  const next = Date.parse(seen);
  return Number.isNaN(next) ? wall : new Date(next + 1).toISOString();
}

/** An item or folder as the JSON it is sealed as. */
export function asJson(record: VaultItem | Folder): JsonObject {
  return overlapCast(record);
}

export function json(value: JsonValue | undefined): string {
  return JSON.stringify(value) ?? "";
}

export function recordOf(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

/** Custom fields by id. */
export function fieldsById(
  value: JsonValue | undefined,
): Map<string, JsonValue> {
  const out = new Map<string, JsonValue>();
  if (!Array.isArray(value)) return out;
  for (const field of value) {
    if (isJsonObject(field) && isString(field.id)) out.set(field.id, field);
  }
  return out;
}

/** The field keys whose value differs between two copies of one item. */
export function changedFieldKeys(prev: VaultItem, next: VaultItem): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const changed: string[] = [];
  const before = asJson(prev);
  const after = asJson(next);
  for (const key of keys) {
    if (ITEM_META_KEYS.has(key) || json(before[key]) === json(after[key]))
      continue;
    if (key === "values") {
      const was = recordOf(before[key]);
      const now = recordOf(after[key]);
      for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (json(was[name]) !== json(now[name])) changed.push(valueKey(name));
      }
    } else if (key === "fields") {
      const was = fieldsById(before[key]);
      const now = fieldsById(after[key]);
      for (const id of new Set([...was.keys(), ...now.keys()])) {
        if (json(was.get(id)) !== json(now.get(id)))
          changed.push(customFieldKey(id));
      }
      // A reorder alone changes no field, but is still this device's edit.
      changed.push("fields");
    } else {
      changed.push(key);
    }
  }
  return changed;
}

function restampItem(
  prev: VaultItem,
  next: VaultItem,
  seen: string,
  at: string,
): VaultItem {
  const changed = changedFieldKeys(prev, next);
  const stamp = next.updatedAt > seen ? next.updatedAt : at;
  const fieldTimes: FieldTimesDraft = { ...prev.fieldTimes };
  for (const [key, time] of Object.entries(next.fieldTimes ?? {})) {
    fieldTimes[key] = later(fieldTimes[key] ?? "", time);
  }
  for (const key of changed) fieldTimes[key] = stamp;
  const deletedAt =
    next.deletedAt !== null &&
    next.deletedAt !== prev.deletedAt &&
    next.deletedAt <= seen
      ? stamp
      : next.deletedAt;
  return { ...next, updatedAt: stamp, deletedAt, fieldTimes };
}

function restampFolder(
  prev: Folder,
  next: Folder,
  seen: string,
  at: string,
): Folder {
  const updatedAt = next.updatedAt ?? next.createdAt;
  return updatedAt > seen ? next : { ...next, updatedAt: at };
}

type Times = Readonly<Record<string, string>>;

function restampTimes(
  before: Times | undefined,
  after: Times,
  seen: string,
  at: string,
): Times {
  let out: Record<string, string> | undefined;
  for (const [id, time] of Object.entries(after)) {
    if (before?.[id] === time || time > seen) continue;
    out ??= { ...after };
    out[id] = at;
  }
  return out ?? after;
}

/** What a write needs from the body as it was, captured before the write runs. */
export type BodyBefore = {
  items: ReadonlyMap<string, VaultItem>;
  folders: ReadonlyMap<string, Folder>;
  tombstones: VaultBody["tombstones"];
  itemTypesAt: VaultBody["itemTypesAt"];
  seen: string;
};

export function captureBefore(body: VaultBody): BodyBefore {
  return {
    items: new Map(body.items.map((item) => [item.id, item])),
    folders: new Map(body.folders.map((folder) => [folder.id, folder])),
    tombstones: body.tombstones,
    itemTypesAt: body.itemTypesAt,
    seen: latestStamp(body),
  };
}

/**
 * Stamp what a local edit changed after everything `before` had seen, and
 * record which item fields it changed. A record the edit did not touch, and
 * one new to the body (an id no other device can hold yet), keeps its times.
 * Never applied to a merge: a merge only carries other devices' stamps.
 */
export function restampEdits(
  before: BodyBefore,
  after: VaultBody,
  now: Date = new Date(),
): void {
  const { seen } = before;
  const at = stampAfter(seen, now);
  after.items = after.items.map((item) => {
    const prev = before.items.get(item.id);
    return prev && prev !== item && json(asJson(prev)) !== json(asJson(item))
      ? restampItem(prev, item, seen, at)
      : item;
  });
  after.folders = after.folders.map((folder) => {
    const prev = before.folders.get(folder.id);
    return prev &&
      prev !== folder &&
      json(asJson(prev)) !== json(asJson(folder))
      ? restampFolder(prev, folder, seen, at)
      : folder;
  });
  const tombstones = after.tombstones;
  if (tombstones) {
    const next: { -readonly [K in keyof VaultTombstones]: Times } = {};
    for (const kind of ["items", "folders", "itemTypes"] as const) {
      const times = tombstones[kind];
      if (times)
        next[kind] = restampTimes(before.tombstones?.[kind], times, seen, at);
    }
    after.tombstones = next;
  }
  if (after.itemTypesAt) {
    after.itemTypesAt = restampTimes(
      before.itemTypesAt,
      after.itemTypesAt,
      seen,
      at,
    );
  }
}
