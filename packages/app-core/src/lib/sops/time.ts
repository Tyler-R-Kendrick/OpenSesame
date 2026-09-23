/**
 * Timestamps as go.yaml.in/yaml/v3 resolves them and as Go renders them.
 *
 * yaml.v3 `parseTimestamp` accepts four `time.Parse` layouts; a matching
 * plain scalar becomes `time.Time`, which upstream encrypts as `type:time`
 * with `MarshalText` (RFC 3339, nanoseconds trimmed of trailing zeros, `Z`
 * for a zero offset). `lastmodified` uses `time.RFC3339` (whole seconds).
 */

import { SopsError } from "./errors.js";

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Fraction digits as written, without the dot. */
  fraction: string;
  /** Offset in minutes; 0 renders as `Z`. */
  offset: number;
};

const TIMESTAMP =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:([Tt])(\d{2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})|[ ](\d{2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,9}))?)?$/u;

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validParts(parts: Parts): boolean {
  if (parts.month < 1 || parts.month > 12) return false;
  if (parts.day < 1 || parts.day > daysIn(parts.year, parts.month))
    return false;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) return false;
  return Math.abs(parts.offset) < 24 * 60;
}

function offsetMinutes(zone: string): number {
  if (zone === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const hours = Number(zone.slice(1, 3));
  const minutes = Number(zone.slice(4, 6));
  if (minutes > 59) return Number.NaN;
  return sign * (hours * 60 + minutes);
}

function render(parts: Parts, withFraction: boolean): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const fraction = withFraction ? parts.fraction.replace(/0+$/u, "") : "";
  const zone =
    parts.offset === 0
      ? "Z"
      : `${parts.offset < 0 ? "-" : "+"}${two(Math.floor(Math.abs(parts.offset) / 60))}:${two(Math.abs(parts.offset) % 60)}`;
  return `${String(parts.year).padStart(4, "0")}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)}${fraction ? `.${fraction}` : ""}${zone}`;
}

/**
 * yaml.v3 plain-scalar timestamp resolution. Returns the `MarshalText`
 * form or null when the text is not a timestamp for that loader.
 */
export function resolveYamlTimestamp(text: string): string | null {
  const match = TIMESTAMP.exec(text);
  if (!match) return null;
  const parts: Parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
    fraction: "",
    offset: 0,
  };
  if (match[4]) {
    parts.hour = Number(match[5]);
    parts.minute = Number(match[6]);
    parts.second = Number(match[7]);
    parts.fraction = match[8] ?? "";
    parts.offset = offsetMinutes(match[9] ?? "Z");
  } else if (match[10]) {
    parts.hour = Number(match[10]);
    parts.minute = Number(match[11]);
    parts.second = Number(match[12]);
    parts.fraction = match[13] ?? "";
  }
  if (Number.isNaN(parts.offset) || !validParts(parts)) return null;
  return render(parts, true);
}

/** Go `time.Time.UnmarshalText` (RFC 3339) → canonical `MarshalText`. */
export function canonicalTimeText(text: string): string {
  const match = RFC3339.exec(text);
  if (!match) {
    throw new SopsError(
      "malformed_encoding",
      "A timestamp value is not RFC 3339.",
    );
  }
  const parts: Parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    fraction: match[7] ?? "",
    offset: offsetMinutes(match[8] ?? "Z"),
  };
  if (Number.isNaN(parts.offset) || !validParts(parts)) {
    throw new SopsError(
      "malformed_encoding",
      "A timestamp value is out of range.",
    );
  }
  return render(parts, true);
}

/**
 * `lastmodified` as upstream formats it for the MAC's associated data:
 * `time.Parse(time.RFC3339, s).Format(time.RFC3339)` — whole seconds, the
 * original offset, `Z` for zero.
 */
export function canonicalLastModified(text: string): string {
  const match = RFC3339.exec(text);
  if (!match) {
    throw new SopsError("invalid_metadata", "lastmodified is not RFC 3339.");
  }
  const parts: Parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    fraction: "",
    offset: offsetMinutes(match[8] ?? "Z"),
  };
  if (Number.isNaN(parts.offset) || !validParts(parts)) {
    throw new SopsError("invalid_metadata", "lastmodified is out of range.");
  }
  return render(parts, false);
}

/** `time.Now().UTC().Format(time.RFC3339)` for a new document. */
export function lastModifiedNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/u, "Z");
}
