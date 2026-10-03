/**
 * Replace one shared field in the open vault (ADR 0150 §2).
 *
 * The catalog decides which field is shared. This only writes a key the
 * catalog can name: a login's username, password or authenticator seed, a
 * secret's value, notes, a custom field, or a typed item's string value.
 * Anything else is refused, so a save cannot invent a property.
 */

import { type BoundaryValue, isString } from "@opensesame/os-domain";
import type { TypedItem, VaultItem } from "@opensesame/vault-core";
import type { FieldValue } from "@opensesame/vault-item-types";
import type { WriteField } from "./host-peer.js";
import { type CatalogInput, sharedItems, vaultField } from "./vault-share.js";

function now(): string {
  return new Date().toISOString();
}

function isText(value: FieldValue | undefined): value is string {
  if (value === undefined) return false;
  // SAFETY: a vault field value is already JSON: a string, a list of strings, or a string record.
  const boundary = value as BoundaryValue;
  return isString(boundary);
}

function writeCustom(
  item: VaultItem,
  key: string,
  text: string,
): VaultItem | null {
  const id = key.slice("custom:".length);
  if (id === "" || !item.fields.some((field) => field.id === id)) return null;
  return {
    ...item,
    fields: item.fields.map((field) =>
      field.id === id ? { ...field, value: text } : field,
    ),
    updatedAt: now(),
  };
}

function writeTyped(
  item: TypedItem,
  key: string,
  text: string,
): VaultItem | null {
  const current = item.values[key];
  if (isText(current)) {
    return {
      ...item,
      values: { ...item.values, [key]: text },
      updatedAt: now(),
    };
  }
  if (key !== "notes") return null;
  return { ...item, notes: text, updatedAt: now() };
}

function writeNamed(
  item: VaultItem,
  key: string,
  text: string,
): VaultItem | null {
  if (item.kind === "login" && key === "username")
    return { ...item, username: text, updatedAt: now() };
  if (item.kind === "login" && key === "password") {
    const at = now();
    return { ...item, password: text, passwordChangedAt: at, updatedAt: at };
  }
  if (item.kind === "login" && key === "totp")
    return { ...item, totp: text, updatedAt: now() };
  if (item.kind === "secret" && key === "value")
    return { ...item, value: text, updatedAt: now() };
  return null;
}

/** The item with `key` set to `text`, or null when that key is not writable. */
export function assignField(
  item: VaultItem,
  key: string,
  text: string,
): VaultItem | null {
  if (key.startsWith("custom:")) return writeCustom(item, key, text);
  if (item.kind === "typed") return writeTyped(item, key, text);
  if (key === "notes") return { ...item, notes: text, updatedAt: now() };
  return writeNamed(item, key, text);
}

/**
 * Save one field that is still shared, against the vault as it stands.
 * `save` is the open vault's own write.
 */
export function vaultWrite(
  input: Pick<CatalogInput, "scope" | "items">,
  save: (item: VaultItem) => Promise<void>,
): WriteField {
  const read = vaultField(input);
  return async (itemId, key, value) => {
    const item = sharedItems(input.items(), input.scope).find(
      (entry) => entry.id === itemId,
    );
    if (!item || (await read(itemId, key)) === null) return false;
    const next = assignField(item, key, value);
    if (!next) return false;
    await save(next);
    return true;
  };
}
