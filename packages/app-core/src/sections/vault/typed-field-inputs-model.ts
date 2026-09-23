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
