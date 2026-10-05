/**
 * The plan "Show my vault without the items I hide" seals, and the one reading
 * of it (ADR 0168).
 *
 * The mode writes it at arming, from copies it took of the owner's chosen
 * items while the real vault was open; the runner reads it at unlock. Both go
 * through this file, so what is sealed and what unlock will add cannot drift.
 * The reader is closed: an unknown key, a kind it does not copy, a count or a
 * length out of range, a non-string where a string belongs, and the whole body
 * is no plan and the runner adds nothing.
 *
 * A copy carries what makes an item look lived in (name, username, password,
 * addresses, notes, custom fields, favourite, dates) and nothing that is key
 * material, history, a link to another item or a place in the vault's folders.
 * What is left out is decided in `visible-items-share.ts`; what this file
 * refuses is anything beyond the closed shape below, so a body written by some
 * other hand cannot smuggle it in.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isString,
} from "@opensesame/os-domain";
import type { UriMatch } from "@opensesame/vault-core";
import { cleanTitle, hasExactKeys, plainObject } from "./shape-kit.js";

/** How many items a body holds and how long each piece of one may be. */
export const VISIBLE_LIMITS = {
  min: 1,
  max: 50,
  name: 120,
  /** Any one value: a username, a password, an address, a field's value. */
  text: 512,
  notes: 4000,
  fieldName: 80,
  fields: 20,
  uris: 10,
  /** Fields of a typed item, entries of a list field, parts of a record one. */
  values: 30,
  list: 20,
  parts: 10,
  typeId: 64,
} as const;

export const URI_MATCHES: readonly UriMatch[] = [
  "domain",
  "host",
  "exact",
  "never",
  "wildcard",
  "regex",
];

export type SharedField = Readonly<{
  name: string;
  value: string;
  hidden: boolean;
}>;
export type SharedUri = Readonly<{ uri: string; match: UriMatch }>;
/** A typed field's value, as the vault stores it (`FieldValue`). */
export type SharedValue = string | string[] | Record<string, string>;

type SharedBase = Readonly<{
  name: string;
  favorite: boolean;
  notes: string;
  fields: SharedField[];
  createdAt: string;
  updatedAt: string;
}>;

/** An item as it is sealed: one of the five kinds a copy is made of. */
export type SharedItem = SharedBase &
  (
    | Readonly<{
        kind: "login";
        username: string;
        password: string;
        passwordChangedAt: string;
        uris: SharedUri[];
      }>
    | Readonly<{ kind: "note" }>
    | Readonly<{ kind: "secret"; value: string }>
    | Readonly<{
        kind: "card";
        cardholder: string;
        brand: string;
        number: string;
        expMonth: string;
        expYear: string;
        code: string;
      }>
    | Readonly<{
        kind: "typed";
        typeId: string;
        values: Readonly<Record<string, SharedValue>>;
      }>
  );

export type VisibleItemsBody = Readonly<{
  v: 1;
  items: SharedItem[];
}>;

const COMMON = [
  "kind",
  "name",
  "favorite",
  "notes",
  "fields",
  "createdAt",
  "updatedAt",
] as const;

const EXTRA = {
  login: ["username", "password", "passwordChangedAt", "uris"],
  note: [],
  secret: ["value"],
  card: ["cardholder", "brand", "number", "expMonth", "expYear", "code"],
  typed: ["typeId", "values"],
} as const satisfies Readonly<Record<SharedItem["kind"], readonly string[]>>;

const KINDS = [
  "login",
  "note",
  "secret",
  "card",
  "typed",
] as const satisfies readonly SharedItem["kind"][];

/** A value that is text no longer than `max`. */
function text(value: BoundaryValue | undefined, max: number): string | null {
  return isString(value) && value.length <= max ? value : null;
}

function date(value: BoundaryValue | undefined): string | null {
  const read = text(value, 40);
  return read !== null && read.length > 0 && !Number.isNaN(Date.parse(read))
    ? read
    : null;
}

/** Every entry read by `each`, or nothing when there are too many or one is refused. */
function listOf<T>(
  value: BoundaryValue | undefined,
  max: number,
  each: (entry: BoundaryValue) => T | null,
): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: T[] = [];
  for (const entry of value) {
    const read = each(entry);
    if (read === null) return null;
    out.push(read);
  }
  return out;
}

function readField(value: BoundaryValue): SharedField | null {
  const object = plainObject(value);
  if (!object || !hasExactKeys(object, ["name", "value", "hidden"])) {
    return null;
  }
  const name = text(object.name, VISIBLE_LIMITS.fieldName);
  const fieldValue = text(object.value, VISIBLE_LIMITS.text);
  if (name === null || fieldValue === null || !isBoolean(object.hidden)) {
    return null;
  }
  return { name, value: fieldValue, hidden: object.hidden };
}

function readUri(value: BoundaryValue): SharedUri | null {
  const object = plainObject(value);
  if (!object || !hasExactKeys(object, ["uri", "match"])) return null;
  const uri = text(object.uri, VISIBLE_LIMITS.text);
  const match = URI_MATCHES.find((known) => known === object.match);
  return uri === null || match === undefined ? null : { uri, match };
}

function readParts(value: JsonObject): Record<string, string> | null {
  const keys = Object.keys(value);
  if (keys.length > VISIBLE_LIMITS.parts) return null;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const part = text(value[key], VISIBLE_LIMITS.text);
    if (part === null || key.length === 0 || key === "__proto__") return null;
    out[key] = part;
  }
  return out;
}

function readSharedValue(value: BoundaryValue): SharedValue | null {
  if (isString(value)) return text(value, VISIBLE_LIMITS.text);
  if (Array.isArray(value)) {
    return listOf(value, VISIBLE_LIMITS.list, (entry) =>
      text(entry, VISIBLE_LIMITS.text),
    );
  }
  const object = plainObject(value);
  return object ? readParts(object) : null;
}

function readValues(
  value: BoundaryValue | undefined,
): Record<string, SharedValue> | null {
  const object = value === undefined ? null : plainObject(value);
  if (!object) return null;
  const keys = Object.keys(object);
  if (keys.length > VISIBLE_LIMITS.values) return null;
  const out: Record<string, SharedValue> = {};
  for (const key of keys) {
    const read = readSharedValue(object[key] ?? null);
    if (read === null || key.length === 0 || key === "__proto__") return null;
    out[key] = read;
  }
  return out;
}

type Base = {
  name: string;
  favorite: boolean;
  notes: string;
  fields: SharedField[];
  createdAt: string;
  updatedAt: string;
};

function readBase(object: JsonObject): Base | null {
  const name = text(object.name, VISIBLE_LIMITS.name);
  const notes = text(object.notes, VISIBLE_LIMITS.notes);
  const fields = listOf(object.fields, VISIBLE_LIMITS.fields, readField);
  const createdAt = date(object.createdAt);
  const updatedAt = date(object.updatedAt);
  if (
    name === null ||
    name.length === 0 ||
    name !== cleanTitle(name) ||
    notes === null ||
    fields === null ||
    createdAt === null ||
    updatedAt === null ||
    !isBoolean(object.favorite)
  ) {
    return null;
  }
  return {
    name,
    favorite: object.favorite,
    notes,
    fields,
    createdAt,
    updatedAt,
  };
}

/** The named strings, in key order, each within the text limit; null when one is not. */
function texts(object: JsonObject, keys: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const key of keys) {
    const read = text(object[key], VISIBLE_LIMITS.text);
    if (read === null) return null;
    out.push(read);
  }
  return out;
}

function readKind(
  kind: SharedItem["kind"],
  object: JsonObject,
  base: Base,
): SharedItem | null {
  switch (kind) {
    case "note":
      return { ...base, kind };
    case "secret": {
      const own = texts(object, ["value"]);
      if (!own) return null;
      const [value = ""] = own;
      return { ...base, kind, value };
    }
    case "card": {
      const own = texts(object, [
        "cardholder",
        "brand",
        "number",
        "expMonth",
        "expYear",
        "code",
      ]);
      if (!own) return null;
      const [
        cardholder = "",
        brand = "",
        number = "",
        expMonth = "",
        expYear = "",
        code = "",
      ] = own;
      return {
        ...base,
        kind,
        cardholder,
        brand,
        number,
        expMonth,
        expYear,
        code,
      };
    }
    case "login": {
      const own = texts(object, ["username", "password"]);
      const uris = listOf(object.uris, VISIBLE_LIMITS.uris, readUri);
      const changed = date(object.passwordChangedAt);
      if (!own || !uris || changed === null) return null;
      const [username = "", password = ""] = own;
      return {
        ...base,
        kind,
        username,
        password,
        passwordChangedAt: changed,
        uris,
      };
    }
    case "typed": {
      const typeId = text(object.typeId, VISIBLE_LIMITS.typeId);
      const values = readValues(object.values);
      if (typeId === null || typeId.length === 0 || values === null) {
        return null;
      }
      return { ...base, kind, typeId, values };
    }
  }
}

function readItem(value: BoundaryValue): SharedItem | null {
  const object = plainObject(value);
  if (!object) return null;
  const kind = KINDS.find((known) => known === object.kind);
  if (kind === undefined) return null;
  if (!hasExactKeys(object, [...COMMON, ...EXTRA[kind]])) return null;
  const base = readBase(object);
  return base && readKind(kind, object, base);
}

/** The items of a sealed body, or nothing: a body that is not exactly ours is not run. */
export function readVisibleItemsBody(body: BoundaryValue): SharedItem[] | null {
  const object = plainObject(body);
  if (!object || !hasExactKeys(object, ["v", "items"]) || object.v !== 1) {
    return null;
  }
  const items = listOf(object.items, VISIBLE_LIMITS.max, readItem);
  return items && items.length >= VISIBLE_LIMITS.min ? items : null;
}
