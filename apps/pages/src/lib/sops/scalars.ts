/**
 * Scalar kinds and their exact upstream byte encodings.
 *
 * `ToBytes` in getsops/sops `sops.go` (26e2f478) and the AES writer in
 * `aes/cipher.go` agree on one byte form per Go type: `strconv.Itoa` for
 * int, `strconv.FormatFloat(v, 'f', -1, 64)` for float64, `True`/`False`
 * for bool, and `time.Time.MarshalText` (RFC 3339 with nanoseconds) for
 * timestamps. Those bytes are what the MAC hashes and what AES-GCM seals,
 * so they are reproduced here byte for byte.
 */

import { SopsError } from "./errors.js";
import { MAX_SCALAR_BYTES } from "./limits.js";

export type SopsScalar =
  | { kind: "str"; value: string }
  /** Canonical decimal text within the Go `int` (int64) range. */
  | { kind: "int"; value: string }
  /** IEEE 754 double; NaN and ±Infinity are representable YAML values. */
  | { kind: "float"; value: number }
  | { kind: "bool"; value: boolean }
  /** RFC 3339 text exactly as Go's `MarshalText` renders it. */
  | { kind: "time"; value: string };

/** What the cipher and MAC see: a scalar or a comment line. */
export type SopsPlain = SopsScalar | { kind: "comment"; value: string };

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const utf8 = new TextEncoder();

/** Go `strconv.FormatFloat(v, 'f', -1, 64)`: shortest digits, no exponent. */
export function goFloatText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const sign = value < 0 ? "-" : "";
  const exponential = Math.abs(value).toExponential();
  const match = /^(\d)(?:\.(\d+))?e([+-]\d+)$/u.exec(exponential);
  if (!match) throw new SopsError("malformed_encoding", "float rendering");
  const digits = `${match[1]}${match[2] ?? ""}`.replace(/0+$/u, "") || "0";
  const exponent = Number(match[3]);
  const point = exponent + 1;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) {
    return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Go `strconv.ParseFloat(text, 64)` on shortest-form decimal text. */
export function goParseFloatText(text: string): number | null {
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u.test(text)) {
    if (text === "+Inf" || text === "Inf") return Number.POSITIVE_INFINITY;
    if (text === "-Inf") return Number.NEGATIVE_INFINITY;
    if (text === "NaN") return Number.NaN;
    return null;
  }
  const parsed = Number(text);
  // Go reports ErrRange on overflow; such text is not a float upstream.
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/** Canonical decimal text for an int64, or null when out of range. */
export function canonicalInt(value: bigint): string | null {
  if (value < INT64_MIN || value > INT64_MAX) return null;
  return value.toString();
}

/**
 * Go `strconv.ParseInt(text, 0, 64)` after yaml.v3 strips underscores:
 * optional sign, then 0x / 0o / 0b prefixes or a leading-zero octal.
 */
export function goParseIntBase0(text: string): bigint | null {
  const match =
    /^([+-]?)(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)$/u.exec(
      text,
    );
  if (!match) return null;
  const negative = match[1] === "-";
  const body = match[2] ?? "";
  let magnitude: bigint;
  if (/^0[xX]/u.test(body)) magnitude = BigInt(`0x${body.slice(2)}`);
  else if (/^0[oO]/u.test(body)) magnitude = BigInt(`0o${body.slice(2)}`);
  else if (/^0[bB]/u.test(body)) magnitude = BigInt(`0b${body.slice(2)}`);
  else if (body.length > 1 && body.startsWith("0")) {
    magnitude = BigInt(`0o${body.slice(1)}`);
  } else magnitude = BigInt(body);
  return negative ? -magnitude : magnitude;
}

/** Upstream `ToBytes`: the exact bytes hashed into the MAC. */
export function plainToBytes(plain: SopsPlain): Uint8Array {
  return utf8.encode(plainToText(plain));
}

/** The text whose UTF-8 bytes the cipher seals and the MAC hashes. */
export function plainToText(plain: SopsPlain): string {
  switch (plain.kind) {
    case "str":
    case "comment":
    case "int":
    case "time":
      return plain.value;
    case "float":
      return goFloatText(plain.value);
    case "bool":
      return plain.value ? "True" : "False";
    default: {
      const unreachable: never = plain;
      return unreachable;
    }
  }
}

export function assertScalarBudget(text: string): void {
  if (text.length > MAX_SCALAR_BYTES) {
    throw new SopsError("resource_limit", "A scalar exceeds the size budget.");
  }
}

/** Structural equality of two scalars by kind and canonical value. */
export function scalarEquals(a: SopsScalar, b: SopsScalar): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "float" && b.kind === "float") {
    return Object.is(a.value, b.value) || a.value === b.value;
  }
  return a.value === b.value;
}
