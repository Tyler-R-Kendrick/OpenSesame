/**
 * Replace one shared field in the open vault (ADR 0150 §2).
 *
 * The catalog decides which field is shared. This only writes a key the
 * catalog can name: an account's username, password or authenticator seed, a
 * secret's value, notes, a custom field, or a typed item's string value.
 * Anything else is refused, so a save cannot invent a property.
 *
 * A password is written into a stored method. For a derived or Sphinx password
 * that is computed and never stored, the write is refused with
 * `PasswordWriteRefused` and nothing is saved (ADR 0174).
 */

import { type BoundaryValue, isString } from "@opensesame/os-domain";
import {
  type AccountItem,
  type TypedItem,
  type VaultItem,
  authenticatorMethod,
  isAlgorithmic,
  passwordMethod,
} from "@opensesame/vault-core";
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

export type PasswordWriteRefusal = "computed" | "no_password";

/** A password write that could not be made without a guess. */
export class PasswordWriteRefused extends Error {
  readonly reason: PasswordWriteRefusal;
  constructor(reason: PasswordWriteRefusal) {
    super(`password_write_refused:${reason}`);
    this.name = "PasswordWriteRefused";
    this.reason = reason;
  }
}

/**
 * A password written into a stored method. One an algorithm computes, or an
 * older version made from a typed pepper, is never written: a stored password
 * would silently replace the algorithm (ADR 0174).
 */
function writePassword(item: AccountItem, text: string): VaultItem {
  const method = passwordMethod(item);
  if (method === undefined) throw new PasswordWriteRefused("no_password");
  if (isAlgorithmic(method) || method.sealed !== undefined) {
    throw new PasswordWriteRefused("computed");
  }
  const at = new Date().toISOString();
  return {
    ...item,
    methods: item.methods.map((entry) =>
      entry.id === method.id
        ? { ...method, secret: text, changedAt: at }
        : entry,
    ),
    updatedAt: at,
  };
}

function writeTotp(item: AccountItem, text: string): VaultItem {
  const current = authenticatorMethod(item);
  const methods = current
    ? item.methods.map((entry) =>
        entry.id === current.id ? { ...current, secret: text } : entry,
      )
    : [
        ...item.methods,
        {
          id: `${item.id}:authenticator`,
          type: "authenticator" as const,
          secret: text,
        },
      ];
  return { ...item, methods, updatedAt: now() };
}

function writeNamed(
  item: VaultItem,
  key: string,
  text: string,
): VaultItem | null {
  if (item.kind === "account" && key === "username")
    return { ...item, username: text, updatedAt: now() };
  if (item.kind === "account" && key === "password")
    return writePassword(item, text);
  if (item.kind === "account" && key === "totp") return writeTotp(item, text);
  if (item.kind === "secret" && key === "value")
    return { ...item, value: text, updatedAt: now() };
  return null;
}

/**
 * The item with `key` set to `text`, or null when that key is not writable.
 * Throws `PasswordWriteRefused` for a password it cannot store honestly.
 */
export async function assignField(
  item: VaultItem,
  key: string,
  text: string,
): Promise<VaultItem | null> {
  if (key.startsWith("custom:")) return writeCustom(item, key, text);
  if (item.kind === "typed") return writeTyped(item, key, text);
  if (key === "notes") return { ...item, notes: text, updatedAt: now() };
  return writeNamed(item, key, text);
}

/**
 * Save one field that is still shared, against the vault as it stands.
 * `save` is the open vault's own write. A refused password write answers
 * `false`, like a field the catalog does not hold.
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
    let next: VaultItem | null;
    try {
      next = await assignField(item, key, value);
    } catch (error) {
      if (error instanceof PasswordWriteRefused) return false;
      throw error;
    }
    if (!next) return false;
    await save(next);
    return true;
  };
}
