/**
 * The request a site hands to the "Save in OpenSesame" button.
 *
 * The payload is untrusted page-authored data. Nothing is saved until the
 * person reviews it in the unlocked vault. The schema is deliberately small:
 * a title, a bounded list of autocomplete field values, and optional notes.
 */

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

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

/** Decode and validate a Base64 save request. `null` means refuse it. */
export function decodeSaveRequest(encoded: string): SaveRequest | null {
  if (typeof encoded !== "string" || encoded.length > MAX_ENCODED) return null;
  let parsed: unknown;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const record = parsed as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (title.length === 0 || title.length > MAX_TITLE) return null;
  if (!Array.isArray(record.fields) || record.fields.length === 0) return null;
  if (record.fields.length > MAX_FIELDS) return null;
  const fields: SaveRequestField[] = [];
  for (const value of record.fields) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;
    const field = value as Record<string, unknown>;
    const autocomplete = text(field.autocomplete, MAX_FIELD_NAME);
    const fieldValue = text(field.value, MAX_FIELD_VALUE);
    if (autocomplete === null || fieldValue === null) return null;
    fields.push({ autocomplete, value: fieldValue });
  }
  const notes =
    record.notes === undefined
      ? undefined
      : (text(record.notes, MAX_NOTES) ?? undefined);
  if (record.notes !== undefined && notes === undefined) return null;
  return { title, fields, ...(notes === undefined ? {} : { notes }) };
}

/** The first value for an autocomplete name, if the site supplied one. */
export function saveRequestField(
  request: SaveRequest,
  name: string,
): string | undefined {
  return request.fields.find((field) => field.autocomplete === name)?.value;
}
