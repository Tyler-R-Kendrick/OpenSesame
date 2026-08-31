/**
 * Projection onto the base native secret (ADR 0087 §3).
 *
 * `sealed_store::Entry` is line one plus a `key: value` trailer, and it is
 * what `opensesame pass`, the `pm-bridges` binaries, `crates/kdbx-bridge` and
 * ConnectionRef materialisation all already read. Every item type declares how
 * it lands there, so a community type is readable by the host plane the day it
 * is authored, with no host-plane code.
 *
 * The projection is total in both directions: a type with no secret field
 * projects an empty line one, and a readback keeps trailer keys the definition
 * does not claim rather than dropping them.
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

export type NativeEntry = {
  /** Line one of the entry. Never contains a newline. */
  readonly secret: string;
  /** The remainder, newline-terminated `key: value` lines. */
  readonly trailer: string;
};

export type NativeReadback = {
  readonly values: FieldValues;
  /** Trailer keys the definition does not claim, kept verbatim. */
  readonly extra: Readonly<Record<string, string>>;
};

const TRAILER_KEY = /^[a-z][a-z0-9_-]*$/;

type TrailerLine = {
  readonly key: string;
  readonly part: string | undefined;
  readonly raw: string;
};

/**
 * Split `key: value` or `key.part: value`, exactly as `split_line` does in
 * `crates/vault-item-types`.
 *
 * Written as a split rather than one regex because a regex that also
 * constrained the part would drop a line like `a.b.c: v` outright, while the
 * Rust side keeps it as an unclaimed key. The two planes read the same file;
 * they have to keep the same things.
 */
function splitTrailerLine(line: string): TrailerLine | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const dot = head.indexOf(".");
  const key = dot === -1 ? head : head.slice(0, dot);
  const part = dot === -1 ? undefined : head.slice(dot + 1);
  if (!TRAILER_KEY.test(key)) return null;
  const rest = line.slice(colon + 1);
  return { key, part, raw: rest.startsWith(" ") ? rest.slice(1) : rest };
}

/**
 * Line one holds no newline and the trailer is line-oriented, so a value that
 * contains one is escaped rather than allowed to split the entry. `pass` users
 * read these files by eye, so the escape is the familiar one.
 */
export function encodeValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

export function decodeValue(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[index + 1];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "\\") out += "\\";
    else {
      out += char;
      continue;
    }
    index += 1;
  }
  return out;
}

function asText(value: FieldValue | undefined): string {
  return isString(value) ? value : "";
}

function asList(value: FieldValue | undefined): readonly string[] {
  if (Array.isArray(value)) return value.filter(isString);
  return isString(value) ? [value] : [];
}

function asRecord(value: FieldValue | undefined): Record<string, string> {
  if (value === undefined || isString(value) || Array.isArray(value)) return {};
  return value;
}

/**
 * `pass-otp` reads an `otpauth://` URI only from a line that *starts* with it
 * (`find_otpauth_in_trailer`), so a TOTP seed is written bare rather than
 * behind its trailer key. The exception belongs to the field type, not to any
 * definition — which is the point of the catalogue being closed.
 */
function isBareOtpauth(field: FieldDefinition, text: string): boolean {
  return field.type === "totp" && text.toLowerCase().startsWith("otpauth://");
}

function trailerLines(
  field: FieldDefinition,
  key: string,
  value: FieldValue | undefined,
): readonly string[] {
  const spec = FIELD_TYPES[field.type];
  if (spec.valueKind === "record") {
    const record = asRecord(value);
    return spec.parts
      .filter((part) => (record[part.id] ?? "") !== "")
      .map(
        (part) => `${key}.${part.id}: ${encodeValue(record[part.id] ?? "")}`,
      );
  }
  if (field.multiple === true) {
    return asList(value)
      .filter((entry) => entry !== "")
      .map((entry) => `${key}: ${encodeValue(entry)}`);
  }
  const text = asText(value);
  if (text === "") return [];
  if (isBareOtpauth(field, text)) return [text];
  return [`${key}: ${encodeValue(text)}`];
}

export function toNativeEntry(
  definition: ItemTypeDefinition,
  values: FieldValues,
): NativeEntry {
  const byId = new Map(definitionFields(definition).map((f) => [f.id, f]));
  const secretId = definition.spec.native.secret;
  const secret = secretId === null ? "" : encodeValue(asText(values[secretId]));

  const lines: string[] = [];
  for (const mapping of definition.spec.native.trailer) {
    const field = byId.get(mapping.field);
    if (field === undefined) continue;
    lines.push(...trailerLines(field, mapping.key, values[mapping.field]));
  }
  const trailer = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return { secret, trailer };
}

/** Render the projection as the plaintext `sealed_store::Entry` body. */
export function renderNativeEntry(entry: NativeEntry): string {
  return `${entry.secret}\n${entry.trailer}`;
}

export function fromNativeEntry(
  definition: ItemTypeDefinition,
  entry: NativeEntry,
): NativeReadback {
  const byKey = new Map(
    definition.spec.native.trailer.map((mapping) => [
      mapping.key,
      mapping.field,
    ]),
  );
  const byId = new Map(definitionFields(definition).map((f) => [f.id, f]));

  const values: Record<string, FieldValue> = {};
  const extra: Record<string, string> = {};
  const lists = new Map<string, string[]>();
  const records = new Map<string, Record<string, string>>();

  const secretId = definition.spec.native.secret;
  if (secretId !== null) values[secretId] = decodeValue(entry.secret);

  const totpField = definition.spec.native.trailer.find(
    (mapping) => byId.get(mapping.field)?.type === "totp",
  );

  for (const line of entry.trailer.split("\n")) {
    if (line.trim() === "") continue;
    if (line.trim().toLowerCase().startsWith("otpauth://")) {
      if (totpField !== undefined) values[totpField.field] = line.trim();
      else extra.otpauth = line.trim();
      continue;
    }
    const parsed = splitTrailerLine(line);
    if (parsed === null) continue;
    const { key, part, raw } = parsed;
    const fieldId = byKey.get(key);
    const field = fieldId === undefined ? undefined : byId.get(fieldId);
    if (fieldId === undefined || field === undefined) {
      extra[part === undefined ? key : `${key}.${part}`] = decodeValue(raw);
      continue;
    }
    const spec = FIELD_TYPES[field.type];
    if (spec.valueKind === "record") {
      const known = spec.parts.some((candidate) => candidate.id === part);
      if (part === undefined || !known) {
        extra[part === undefined ? key : `${key}.${part}`] = decodeValue(raw);
        continue;
      }
      const record = records.get(fieldId) ?? {};
      record[part] = decodeValue(raw);
      records.set(fieldId, record);
      continue;
    }
    if (field.multiple === true) {
      const list = lists.get(fieldId) ?? [];
      list.push(decodeValue(raw));
      lists.set(fieldId, list);
      continue;
    }
    values[fieldId] = decodeValue(raw);
  }

  for (const [fieldId, list] of lists) values[fieldId] = list;
  for (const [fieldId, record] of records) values[fieldId] = record;
  return { values, extra };
}
