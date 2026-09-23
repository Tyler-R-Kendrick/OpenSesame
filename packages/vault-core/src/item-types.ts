/**
 * This device's item-type registry (ADR 0087).
 *
 * The built-in corpus is embedded in `@opensesame/vault-item-types`; anything
 * else the user installed lives in the sealed vault body, so it syncs E2EE to
 * their other devices and needs no server. Installing and uninstalling are
 * data writes — nothing here rebuilds or reloads the app.
 *
 * The other job of this module is the legacy seam. The seven kinds that
 * predate the registry store their fields as named properties on the item
 * (`item.username`), while a plugin-defined item stores them in `values`. One
 * accessor reads both, so the generic renderer and the native projection work
 * over every item regardless of how it was written.
 */

import {
  type JsonObject,
  isBoolean,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type FieldDefinition,
  type FieldValue,
  type FieldValues,
  type ItemTypeDefinition,
  type ItemTypeRegistry,
  builtinRegistry,
  definitionFields,
  describeErrors,
  emptyValues,
  searchTextFor,
  subtitleFor,
} from "@opensesame/vault-item-types";
import type { InstalledItemTypes, VaultItem } from "./model.js";

let registry: ItemTypeRegistry = builtinRegistry();

/** Definitions installed into this vault, keyed by type id, as authored JSON. */
let installedSource: InstalledItemTypes = {};

export function itemTypeRegistry(): ItemTypeRegistry {
  return registry;
}

/**
 * Rebuild the registry from the sealed body's installed definitions.
 *
 * Called on unlock and after every sync. A definition that no longer parses —
 * because it arrived from a newer client, say — is skipped rather than
 * throwing: items of that type still render through the unknown-type
 * fallback, and no data is touched.
 */
export function syncInstalledTypes(
  installed: InstalledItemTypes | undefined,
): void {
  registry = builtinRegistry();
  installedSource = installed ?? {};
  for (const text of Object.values(installedSource)) {
    if (text === undefined) continue;
    registry.install(text, "vault");
  }
}

export type InstallResult =
  | { readonly ok: true; readonly definition: ItemTypeDefinition }
  | { readonly ok: false; readonly message: string };

/**
 * Validate a definition and register it. The caller persists
 * `installedDefinitions()` into the vault body; nothing here writes.
 */
export function installItemType(text: string): InstallResult {
  const outcome = registry.install(text, "vault");
  if (!outcome.ok)
    return { ok: false, message: describeErrors(outcome.errors) };
  installedSource = {
    ...installedSource,
    [outcome.definition.metadata.id]: text,
  };
  return { ok: true, definition: outcome.definition };
}

/** Remove a definition. Items of that type keep every value they hold. */
export function uninstallItemType(id: string): boolean {
  if (!registry.uninstall(id)) return false;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(installedSource)) {
    if (key !== id && value !== undefined) next[key] = value;
  }
  installedSource = next;
  return true;
}

export function installedDefinitions(): InstalledItemTypes {
  return installedSource;
}

/** The type id an item was created with, whichever storage shape it uses. */
export function itemTypeId(item: VaultItem): string {
  return item.kind === "typed" ? item.typeId : item.kind;
}

export function definitionFor(item: VaultItem): ItemTypeDefinition | undefined {
  return registry.get(itemTypeId(item));
}

/**
 * Read one declared field off an item.
 *
 * A plugin-defined item keeps its values in `values`. A built-in item keeps
 * them as named properties, and the definitions name their fields to match,
 * so the same call reads both.
 */
export function readItemField(
  item: VaultItem,
  field: FieldDefinition,
): FieldValue | undefined {
  if (item.kind === "typed") return item.values[field.id];
  const record: JsonObject = overlapCast(item);
  return coerceLegacy(record[field.id]);
}

/**
 * Legacy properties are not all text. A login's URIs are records with a match
 * rule, and a passkey's `unlocksVault` is a boolean; both flatten to the text
 * the definition declared without touching what is stored.
 */
function coerceLegacy(value: JsonObject[string]): FieldValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (isString(value)) return value;
  if (isBoolean(value)) return value ? "true" : "";
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (isString(entry)) return [entry];
      const record: JsonObject = overlapCast(entry);
      const uri = record.uri;
      return isString(uri) ? [uri] : [];
    });
  }
  return undefined;
}

/** Every declared field of an item, as the projection and renderer see it. */
export function itemValues(
  item: VaultItem,
  definition: ItemTypeDefinition,
): FieldValues {
  const values: Record<string, FieldValue> = {};
  for (const field of definitionFields(definition)) {
    const value = readItemField(item, field);
    if (value !== undefined) values[field.id] = value;
  }
  return values;
}

export function newValues(definition: ItemTypeDefinition): FieldValues {
  const values = { ...emptyValues(definition) };
  for (const field of definitionFields(definition)) {
    if (field.default !== undefined) values[field.id] = field.default;
  }
  return values;
}

/** The label for a type id, including one this device has never seen. */
export function typeLabel(id: string): string {
  return registry.get(id)?.spec.title ?? id;
}

export function typePlural(id: string): string {
  return registry.get(id)?.spec.plural ?? id;
}

/** The VFS extension for a type, or a slug fallback for an unknown one. */
export function typeExtension(id: string): string {
  return (
    registry.get(id)?.spec.extension ?? `.${id.replaceAll(/[^a-z0-9]/g, "")}`
  );
}

/** The list subtitle for a plugin-defined item. Never a concealed value. */
export function typedSubtitle(item: VaultItem): string {
  const definition = definitionFor(item);
  if (definition === undefined) return unknownTypeSubtitle(item);
  const text = subtitleFor(definition, itemValues(item, definition));
  return text === "" ? definition.spec.title : text;
}

/** The search haystack for a plugin-defined item. Never a concealed value. */
export function typedSearchText(item: VaultItem): string[] {
  const definition = definitionFor(item);
  if (definition === undefined) return [itemTypeId(item)];
  return [...searchTextFor(definition, itemValues(item, definition))];
}

/**
 * What to say about an item whose type is not installed here. Never "unknown
 * item" and never a coercion: the definition may arrive on the next sync, and
 * the values are intact either way.
 */
export function unknownTypeSubtitle(item: VaultItem): string {
  const count = item.kind === "typed" ? Object.keys(item.values).length : 0;
  return count === 1
    ? "1 field · type not installed"
    : `${count} fields · type not installed`;
}
