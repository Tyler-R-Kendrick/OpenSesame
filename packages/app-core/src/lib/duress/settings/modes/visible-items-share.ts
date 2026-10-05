import { isString, isTypeofObject } from "@opensesame/os-domain";
/**
 * Which of the open vault's items may be shown under a duress code, and the
 * copy of one (ADR 0168).
 *
 * A copy is built by naming what it keeps, never by deleting from the item: a
 * field added to the item model tomorrow is therefore left out until someone
 * decides it belongs here. Kept: name, the kind's own plain fields, notes,
 * custom fields, favourite, and the two dates that make an item look lived in.
 * Left out, always: passkeys, certificates, drops, files and every other kind
 * that is key material; one-time-code seeds; an account's other login methods
 * and any password kept under a pepper or computed by Sphinx (the copy holds
 * only a password that is in the clear in the vault already, else none); concealed custom fields; history; the links that tie an
 * item to a reset or a replacement; its folder; its grants to agents; anything
 * in the trash. A typed item is offered only when its definition is built in,
 * is loaded here, and declares no field that holds a seed, a key or a file.
 *
 * Pure: a function of the items it is handed, with no reach into the vault.
 */

import {
  KIND_LABEL,
  type VaultItem,
  accountPlainPassword,
  isRetired,
  itemTypeRegistry,
  passwordMethod,
  typeLabel,
} from "@opensesame/vault-core";
import {
  type FieldTypeId,
  definitionFields,
} from "@opensesame/vault-item-types";
import type { DuressPickRow } from "./mode.js";
import { cleanTitle } from "./shape-kit.js";
import {
  type SharedItem,
  type SharedValue,
  VISIBLE_LIMITS,
} from "./visible-items-shape.js";

/** Field types whose value is a seed, a key or a file: an item that has one is not offered. */
const MATERIAL: ReadonlySet<FieldTypeId> = new Set([
  "totp",
  "key-material",
  "key-pair",
  "blob",
]);

/** Typed items that are the kinds never copied, whatever else their definitions say. */
const NEVER_TYPES: ReadonlySet<string> = new Set([
  "file",
  "passkey",
  "certificate",
  "drop",
]);

function cut(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function cutText(value: string): string {
  return cut(value, VISIBLE_LIMITS.text);
}

/** A date the reader will accept: the item's own when it parses, else `fallback`. */
function when(value: string, fallback: string): string {
  return value.length > 0 &&
    value.length <= 40 &&
    !Number.isNaN(Date.parse(value))
    ? value
    : fallback;
}

/** The declared fields of a typed item's definition, or none when it may not be copied. */
function copyableFields(typeId: string) {
  if (NEVER_TYPES.has(typeId)) return null;
  const registry = itemTypeRegistry();
  if (registry.sourceOf(typeId) !== "builtin") return null;
  const definition = registry.get(typeId);
  if (!definition) return null;
  const fields = definitionFields(definition);
  return fields.some((field) => MATERIAL.has(field.type)) ? null : fields;
}

/** Whether a copy of `item` may be made: the rules in the header, one place. */
export function isShareable(item: VaultItem): boolean {
  if (item.deletedAt !== null || isRetired(item)) return false;
  if (cleanTitle(item.name).length === 0) return false;
  switch (item.kind) {
    case "account":
    case "note":
    case "secret":
    case "card":
      return true;
    case "typed":
      return copyableFields(item.typeId) !== null;
    default:
      return false;
  }
}

/** The items of `items` that may be shown, in the vault's order. */
export function shareableItems(items: readonly VaultItem[]): VaultItem[] {
  return items.filter(isShareable);
}

/** One row of the sheet's list: the item's id, its name and what kind it is. Never a secret. */
export function pickRows(items: readonly VaultItem[]): DuressPickRow[] {
  return shareableItems(items).map((item) => ({
    id: item.id,
    label: cleanTitle(item.name),
    detail:
      item.kind === "typed" ? typeLabel(item.typeId) : KIND_LABEL[item.kind],
  }));
}

function sharedValue(
  value: (VaultItem & { kind: "typed" })["values"][string] | undefined,
): SharedValue | null {
  if (isString(value)) return cutText(value);
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => isString(entry))
      .slice(0, VISIBLE_LIMITS.list)
      .map(cutText);
  }
  if (isTypeofObject(value) && value !== null) {
    const out: Record<string, string> = {};
    for (const [key, part] of Object.entries(value).slice(
      0,
      VISIBLE_LIMITS.parts,
    )) {
      if (isString(part) && key !== "__proto__") {
        out[key] = cutText(part);
      }
    }
    return out;
  }
  return null;
}

function typedValues(
  item: VaultItem & { kind: "typed" },
): Record<string, SharedValue> | null {
  const fields = copyableFields(item.typeId);
  if (!fields) return null;
  const out: Record<string, SharedValue> = {};
  for (const field of fields.slice(0, VISIBLE_LIMITS.values)) {
    const value = sharedValue(item.values[field.id]);
    if (value !== null) out[field.id] = value;
  }
  return out;
}

/** The copy of an item that is shareable, or nothing. */
export function shareItem(item: VaultItem): SharedItem | null {
  if (!isShareable(item)) return null;
  const createdAt = when(item.createdAt, new Date().toISOString());
  const updatedAt = when(item.updatedAt, createdAt);
  const base = {
    name: cut(cleanTitle(item.name), VISIBLE_LIMITS.name),
    favorite: item.favorite,
    notes: cut(item.notes, VISIBLE_LIMITS.notes),
    // A concealed custom field is where people keep a PIN, a security answer
    // or a one-time-code seed, so it is never copied; a plain one is.
    fields: item.fields
      .filter((field) => !field.hidden)
      .slice(0, VISIBLE_LIMITS.fields)
      .map((field) => ({
        name: cut(field.name, VISIBLE_LIMITS.fieldName),
        value: cutText(field.value),
        hidden: false,
      })),
    createdAt,
    updatedAt,
  };
  switch (item.kind) {
    case "account":
      // The copy's wire kind stays `login`: plans armed before accounts hold it.
      return {
        ...base,
        kind: "login",
        username: cutText(item.username),
        password: cutText(accountPlainPassword(item)),
        passwordChangedAt: when(
          passwordMethod(item)?.changedAt ?? "",
          updatedAt,
        ),
        uris: item.uris.slice(0, VISIBLE_LIMITS.uris).map((entry) => ({
          uri: cutText(entry.uri),
          match: entry.match,
        })),
      };
    case "note":
      return { ...base, kind: "note" };
    case "secret":
      return { ...base, kind: "secret", value: cutText(item.value) };
    case "card":
      return {
        ...base,
        kind: "card",
        cardholder: cutText(item.cardholder),
        brand: cutText(item.brand),
        number: cutText(item.number),
        expMonth: cutText(item.expMonth),
        expYear: cutText(item.expYear),
        code: cutText(item.code),
      };
    case "typed": {
      const values = typedValues(item);
      return values
        ? { ...base, kind: "typed", typeId: item.typeId, values }
        : null;
    }
    default:
      return null;
  }
}
