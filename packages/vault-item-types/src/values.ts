/**
 * Reading and writing the values an item holds for its type's fields.
 *
 * Values are text (or a list of text, or a record of named text parts) because
 * the base native secret is text and every type projects onto it. Nothing here
 * knows about React, storage, or the vault — it is the seam every surface uses
 * so that the item list, the search index, and the VFS filename all obey the
 * same preview rule.
 */

import { isString } from "@opensesame/os-domain";
import { FIELD_TYPES } from "./catalogue.js";
import {
  type FieldDefinition,
  type FieldValue,
  type FieldValues,
  type ItemTypeDefinition,
  definitionFields,
} from "./schema.js";

export function emptyValueFor(field: FieldDefinition): FieldValue {
  const spec = FIELD_TYPES[field.type];
  if (spec.valueKind === "record") {
    const record: Record<string, string> = {};
    for (const part of spec.parts) record[part.id] = "";
    return record;
  }
  return field.multiple === true ? [] : "";
}

export function emptyValues(definition: ItemTypeDefinition): FieldValues {
  const values: Record<string, FieldValue> = {};
  for (const field of definitionFields(definition)) {
    values[field.id] = emptyValueFor(field);
  }
  return values;
}

/** The value flattened to one line of display text. Never used for concealed
    fields — those render through a reveal gesture, not a summary. */
export function displayText(
  field: FieldDefinition,
  value: FieldValue | undefined,
): string {
  if (value === undefined) return "";
  if (isString(value)) return value;
  if (Array.isArray(value)) return value.filter(isString).join(", ");
  const spec = FIELD_TYPES[field.type];
  return spec.parts
    .map((part) => value[part.id] ?? "")
    .filter((text) => text !== "")
    .join(", ");
}

function previewTexts(
  definition: ItemTypeDefinition,
  values: FieldValues,
  ids: readonly string[],
): readonly string[] {
  const byId = new Map(definitionFields(definition).map((f) => [f.id, f]));
  const out: string[] = [];
  for (const id of ids) {
    const field = byId.get(id);
    // Belt and braces: the parser refuses a concealed field here, and the
    // renderer refuses to print one anyway. Both, because either alone is one
    // review away from being the only thing standing between a secret and the
    // item list.
    if (field === undefined || FIELD_TYPES[field.type].concealed) continue;
    const text = displayText(field, values[id]);
    if (text !== "") out.push(text);
  }
  return out;
}

/** The line under the item's name in a list. Never a concealed value. */
export function subtitleFor(
  definition: ItemTypeDefinition,
  values: FieldValues,
): string {
  return previewTexts(definition, values, definition.spec.subtitle).join(" · ");
}

/** The searchable text for this item. Never a concealed value. */
export function searchTextFor(
  definition: ItemTypeDefinition,
  values: FieldValues,
): readonly string[] {
  return previewTexts(definition, values, definition.spec.search);
}

export type MissingField = {
  readonly id: string;
  readonly label: string;
};

/** Required fields with nothing in them, in declaration order. */
export function missingRequired(
  definition: ItemTypeDefinition,
  values: FieldValues,
): readonly MissingField[] {
  const missing: MissingField[] = [];
  for (const field of definitionFields(definition)) {
    if (field.required !== true) continue;
    if (displayText(field, values[field.id]) !== "") continue;
    missing.push({ id: field.id, label: field.label });
  }
  return missing;
}

/**
 * Drop values whose field the definition no longer declares.
 *
 * Used only where a caller explicitly wants the trimmed shape. Storage never
 * calls it: an item whose type is not installed on this device keeps every
 * value it arrived with, because the definition may turn up on the next sync
 * and a merge is last-writer-wins per item (ADR 0087 §7).
 */
export function pruneValues(
  definition: ItemTypeDefinition,
  values: FieldValues,
): FieldValues {
  const declared = new Set(definitionFields(definition).map((f) => f.id));
  const out: Record<string, FieldValue> = {};
  for (const [id, value] of Object.entries(values)) {
    if (declared.has(id) && value !== undefined) out[id] = value;
  }
  return out;
}
