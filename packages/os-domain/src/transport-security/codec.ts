/**
 * Decoding primitives shared by every transport DTO: strict RFC 3339, ids,
 * references, selectors, enums, and unknown-field rejection. Hand-written
 * (os-domain carries no schema library) and deliberately narrow: nothing is
 * coerced, and every refusal is `malformed_configuration` with a detail that
 * names the field, never the value.
 */

import {
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "../json.js";
import {
  type IdentitySourceRef,
  type PeerIdentitySelector,
  SELECTOR_KINDS,
  type SelectorKind,
  type TransportErrorCode,
  type TransportErrorView,
  type TransportResult,
  type TrustProfileRef,
} from "./types.js";

export const MAX_ID_BYTES = 128;
export const MAX_REF_NAME_BYTES = 64;
export const MAX_SELECTOR_BYTES = 2048;

const ID_PATTERN = /^[\x21-\x7E]{1,128}$/;
const REF_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const THUMBPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function transportError(
  code: TransportErrorCode,
  detail: string | null = null,
): TransportErrorView {
  return { code, detail };
}

export function fail<T>(detail: string): TransportResult<T> {
  return {
    ok: false,
    error: transportError("malformed_configuration", detail),
  };
}

export function failWith<T>(code: TransportErrorCode): TransportResult<T> {
  return { ok: false, error: transportError(code) };
}

export function succeed<T>(value: T): TransportResult<T> {
  return { ok: true, value };
}

/** A refusal thrown by [`need`] and caught by [`attempt`]. */
class Refusal extends Error {
  constructor(readonly refusal: TransportErrorView) {
    super(refusal.detail ?? refusal.code);
  }
}

/** Unwrap a result inside an [`attempt`] block; a failure ends the block. */
export function need<T>(result: TransportResult<T>): T {
  if (result.ok) return result.value;
  throw new Refusal(result.error);
}

/** Build a value from several decoded parts, returning the first refusal. */
export function attempt<T>(build: () => T): TransportResult<T> {
  try {
    return succeed(build());
  } catch (caught) {
    if (caught instanceof Refusal) return { ok: false, error: caught.refusal };
    throw caught;
  }
}

// ── Timestamps ─────────────────────────────────────────────────────────

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function offsetMinutes(offset: string): number | null {
  if (offset === "Z") return 0;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) return null;
  const magnitude = hours * 60 + minutes;
  return offset.startsWith("-") ? -magnitude : magnitude;
}

interface CalendarParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function calendarParts(match: RegExpExecArray): CalendarParts | null {
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

function inCalendar(p: CalendarParts): boolean {
  return (
    p.month >= 1 &&
    p.month <= 12 &&
    p.day >= 1 &&
    p.day <= daysInMonth(p.year, p.month) &&
    p.hour <= 23 &&
    p.minute <= 59 &&
    p.second <= 59
  );
}

/**
 * Parse a strict RFC 3339 timestamp: uppercase `T`/`Z`, an offset always,
 * at most three fractional digits, no leap second, real calendar values.
 * Returns `null` on any refusal (V8's `Date` would silently roll over).
 */
export function parseRfc3339(input: string): Date | null {
  const match = RFC3339.exec(input);
  if (!match) return null;
  const parts = calendarParts(match);
  const offset = offsetMinutes(match[8] ?? "Z");
  if (parts === null || !inCalendar(parts) || offset === null) return null;
  const millis = Number((match[7] ?? "0").padEnd(3, "0"));
  const date = new Date(
    Date.UTC(
      2000,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  date.setUTCFullYear(parts.year);
  date.setUTCMilliseconds(millis);
  return new Date(date.getTime() - offset * 60_000);
}

/** Canonical form: UTC, millisecond precision, `Z` suffix. */
export function canonicalTimestamp(date: Date): string {
  return date.toISOString();
}

export function decodeTimestamp(
  field: string,
  value: JsonValue | undefined,
): TransportResult<string> {
  if (!isString(value)) return fail(`${field}: timestamp must be a string`);
  const parsed = parseRfc3339(value);
  return parsed
    ? succeed(canonicalTimestamp(parsed))
    : fail(`${field}: timestamp must be strict RFC 3339 with an offset`);
}

// ── Scalars ────────────────────────────────────────────────────────────

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function isValidThumbprint(value: string): boolean {
  return THUMBPRINT_PATTERN.test(value);
}

export function isValidRefName(value: string): boolean {
  return REF_NAME_PATTERN.test(value) && value.length <= MAX_REF_NAME_BYTES;
}

export function decodeId(
  field: string,
  value: JsonValue | undefined,
): TransportResult<string> {
  if (!isString(value) || !isValidId(value)) {
    return fail(
      `${field}: id must be printable ASCII, 1..=${MAX_ID_BYTES} bytes`,
    );
  }
  return succeed(value);
}

export function decodeThumbprint(
  field: string,
  value: JsonValue | undefined,
): TransportResult<string> {
  if (!isString(value) || !isValidThumbprint(value)) {
    return fail(`${field}: thumbprint must be 64 lowercase hex characters`);
  }
  return succeed(value);
}

export function decodeBoolean(
  field: string,
  value: JsonValue | undefined,
): TransportResult<boolean> {
  return isBoolean(value)
    ? succeed(value)
    : fail(`${field}: must be a boolean`);
}

/** A non-negative integer within JavaScript's exact range. */
export function decodeGeneration(
  field: string,
  value: JsonValue | undefined,
  minimum = 0,
): TransportResult<number> {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < minimum) {
    return fail(`${field}: must be an integer >= ${minimum}`);
  }
  return succeed(value);
}

export function decodeEnum<const T extends readonly string[]>(
  field: string,
  allowed: T,
  value: JsonValue | undefined,
): TransportResult<T[number]> {
  if (!isString(value)) return fail(`${field}: must be a string`);
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined
    ? fail(`${field}: unknown variant`)
    : succeed(found);
}

// ── Objects ────────────────────────────────────────────────────────────

/** An object carrying exactly `required` keys plus none outside `optional`. */
export function decodeObject(
  field: string,
  value: JsonValue | undefined,
  required: readonly string[],
  optional: readonly string[] = [],
): TransportResult<JsonObject> {
  if (!isJsonObject(value)) return fail(`${field}: must be an object`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      return fail(`${field}: unknown field ${key}`);
    }
  }
  for (const key of required) {
    if (!(key in value)) return fail(`${field}: missing field ${key}`);
  }
  return succeed(value);
}

/** An externally tagged enum value: `"unit"` or `{ tag: payload }`. */
export function decodeTagged(
  field: string,
  value: JsonValue | undefined,
  units: readonly string[],
  tags: readonly string[],
): TransportResult<{ tag: string; payload: JsonValue | undefined }> {
  if (isString(value)) {
    return units.includes(value)
      ? succeed({ tag: value, payload: undefined })
      : fail(`${field}: unknown variant`);
  }
  if (!isJsonObject(value)) return fail(`${field}: must be a variant`);
  const keys = Object.keys(value);
  const tag = keys[0];
  if (keys.length !== 1 || tag === undefined || !tags.includes(tag)) {
    return fail(`${field}: must carry exactly one known variant`);
  }
  return succeed({ tag, payload: value[tag] });
}

export function decodeStringList(
  field: string,
  value: JsonValue | undefined,
  each: (field: string, item: JsonValue | undefined) => TransportResult<string>,
  maxEntries: number,
): TransportResult<readonly string[]> {
  if (!Array.isArray(value)) return fail(`${field}: must be an array`);
  if (value.length > maxEntries)
    return fail(`${field}: more than ${maxEntries} entries`);
  const out: string[] = [];
  for (const item of value) {
    const decoded = each(field, item);
    if (!decoded.ok) return decoded;
    if (out.includes(decoded.value)) return fail(`${field}: duplicate entry`);
    out.push(decoded.value);
  }
  return succeed(out);
}

// ── References ───────────────────────────────────────────

function decodeRef(
  field: string,
  value: JsonValue | undefined,
): TransportResult<{ readonly name: string }> {
  const object = decodeObject(field, value, ["name"]);
  if (!object.ok) return object;
  const name = object.value.name;
  if (!isString(name) || !isValidRefName(name)) {
    return fail(`${field}: name must match ^[a-z0-9][a-z0-9._-]{0,63}$`);
  }
  return succeed({ name });
}

export function decodeTrustProfileRef(
  field: string,
  value: JsonValue | undefined,
): TransportResult<TrustProfileRef> {
  return decodeRef(field, value);
}

export function decodeIdentitySourceRef(
  field: string,
  value: JsonValue | undefined,
): TransportResult<IdentitySourceRef> {
  return decodeRef(field, value);
}
