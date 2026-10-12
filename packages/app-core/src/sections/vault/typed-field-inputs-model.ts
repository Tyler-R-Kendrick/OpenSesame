import { isString } from "@opensesame/os-domain";
/**
 * View-model logic for `TypedFieldInputs` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import {
  FIELD_TYPES,
  type FieldDefinition,
  type FieldTypeId,
  type FieldValue,
} from "@opensesame/vault-item-types";
import { FIELD_LIMITS } from "../../lib/vault/field-limits.js";

/**
 * The HTML input type a catalogue entry asks for.
 *
 * A switch rather than a lookup table: the catalogue is closed, so the
 * exhaustive arm is free, and there is no key this can be asked for that it
 * has not already answered.
 */
export function htmlInputType(id: FieldTypeId): string {
  switch (id) {
    case "email":
      return "email";
    case "url":
      return "url";
    case "number":
      return "number";
    case "date":
      return "date";
    case "month-year":
      return "month";
    case "phone":
      return "tel";
    default:
      return "text";
  }
}

export function inputType(field: FieldDefinition, revealed: boolean): string {
  if (FIELD_TYPES[field.type].concealed) return revealed ? "text" : "password";
  return htmlInputType(field.type);
}

/**
 * How many characters a catalogue entry's input takes. Free text and key
 * material run long, a concealed value is a secret, a web address is a URL, and
 * everything else is one line; the catalogue is closed, so the default is only
 * ever reached by the types that mean "a line".
 */
export function fieldMaxLength(field: FieldDefinition): number {
  const spec = FIELD_TYPES[field.type];
  if (spec.multiline) return FIELD_LIMITS.text;
  if (spec.concealed) return FIELD_LIMITS.secret;
  if (field.type === "url") return FIELD_LIMITS.uri;
  if (field.type === "email") return 320;
  return FIELD_LIMITS.line;
}

/** A part of a record field: key material runs long, the rest is a line. */
export function partMaxLength(
  field: FieldDefinition,
  part: { concealed: boolean },
): number {
  return field.type === "key-pair" || part.concealed
    ? FIELD_LIMITS.secret
    : FIELD_LIMITS.line;
}

export function asText(value: FieldValue | undefined): string {
  return isString(value) ? value : "";
}

export function asList(value: FieldValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter(isString);
  return isString(value) && value !== "" ? [value] : [];
}

export function asParts(value: FieldValue | undefined): Record<string, string> {
  if (value === undefined || isString(value) || Array.isArray(value)) return {};
  return value;
}
