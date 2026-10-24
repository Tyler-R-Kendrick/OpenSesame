/**
 * The request a site hands to the "Save in OpenSesame" button.
 *
 * The payload is untrusted page-authored data. Nothing is saved until the
 * person reviews it in the unlocked vault. The schema is deliberately small:
 * a title, a bounded list of autocomplete field values, and optional notes.
 */

import { type JsonValue, isJsonObject, isString } from "@opensesame/os-domain";

export const SAVE_REQUEST_TYPES = [
  "login",
  "credit-card",
  "crypto-wallet",
] as const;

export type SaveRequestType = (typeof SAVE_REQUEST_TYPES)[number];

export type SaveRequestField = {
  autocomplete: string;
  value: string;
};

export type SaveRequest = {
  title: string;
  fields: SaveRequestField[];
  notes?: string;
};

const MAX_ENCODED = 128 * 1024;
const MAX_TITLE = 200;
const MAX_FIELD_NAME = 100;
const MAX_FIELD_VALUE = 8192;
const MAX_FIELDS = 64;
const MAX_NOTES = 16_384;

function text(value: JsonValue | undefined, max: number): string | null {
  return isString(value) && value.length > 0 && value.length <= max
    ? value
    : null;
}

/** The request's JSON, or null when it is not Base64 of UTF-8 JSON. */
function readEncoded(encoded: string): JsonValue {
  if (!isString(encoded) || encoded.length > MAX_ENCODED) return null;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: JsonValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return parsed;
  } catch {
    return null;
  }
}

function readField(value: JsonValue): SaveRequestField | null {
  if (!isJsonObject(value)) return null;
  const autocomplete = text(value.autocomplete, MAX_FIELD_NAME);
  const fieldValue = text(value.value, MAX_FIELD_VALUE);
  if (autocomplete === null || fieldValue === null) return null;
  return { autocomplete, value: fieldValue };
}

/** One to `MAX_FIELDS` fields, every one of them readable, or null. */
function readFields(value: JsonValue | undefined): SaveRequestField[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > MAX_FIELDS) return null;
  const fields: SaveRequestField[] = [];
  for (const entry of value) {
    const field = readField(entry);
    if (field === null) return null;
    fields.push(field);
  }
  return fields;
}

/** Absent notes are undefined; notes that do not read refuse the request. */
function readNotes(value: JsonValue | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return isString(value) && value.length <= MAX_NOTES ? value : null;
}

/** Decode and validate a Base64 save request. `null` means refuse it. */
export function decodeSaveRequest(encoded: string): SaveRequest | null {
  const parsed = readEncoded(encoded);
  if (!isJsonObject(parsed)) return null;
  const title = isString(parsed.title) ? parsed.title.trim() : "";
  if (title.length === 0 || title.length > MAX_TITLE) return null;
  const fields = readFields(parsed.fields);
  const notes = readNotes(parsed.notes);
  if (fields === null || notes === null) return null;
  return notes === undefined ? { title, fields } : { title, fields, notes };
}

/** The first value for an autocomplete name, if the site supplied one. */
export function saveRequestField(
  request: SaveRequest,
  name: string,
): string | undefined {
  return request.fields.find((field) => field.autocomplete === name)?.value;
}
