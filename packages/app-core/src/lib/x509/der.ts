/**
 * A minimal DER (ITU-T X.690) encoder: exactly the types a self-signed X.509
 * v3 certificate is made of, and nothing else. Every function returns a
 * complete tag-length-value in canonical DER — definite lengths in their
 * shortest form, minimal INTEGERs, trailing-zero-trimmed named bit lists —
 * so a structure is built by nesting calls. There is no decoder.
 */

/** Universal tags used by the certificate profile. */
export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  OBJECT_IDENTIFIER: 0x06,
  UTF8_STRING: 0x0c,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** Join byte strings end to end. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * A definite length: one byte below 128, otherwise 0x80 | n followed by the
 * n big-endian length bytes, with no leading zero byte.
 */
export function encodeLength(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`DER length ${length} is not a non-negative integer`);
  }
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 0x100)) {
    bytes.unshift(rest % 0x100);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** One tag-length-value. */
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), encodeLength(content.length), content]);
}

export function sequence(...items: Uint8Array[]): Uint8Array {
  return tlv(TAG.SEQUENCE, concat(items));
}

/** A SET OF; callers pass at most one member, so no DER sorting is needed. */
export function setOf(item: Uint8Array): Uint8Array {
  return tlv(TAG.SET, item);
}

/**
 * A non-negative INTEGER from its big-endian magnitude: leading zero bytes
 * are dropped, and one 0x00 is put back when the top bit would otherwise
 * read as a sign. Zero encodes as a single 0x00.
 */
export function unsignedInteger(magnitude: Uint8Array): Uint8Array {
  let start = 0;
  while (start < magnitude.length && magnitude[start] === 0) start += 1;
  const trimmed = magnitude.subarray(start);
  if (trimmed.length === 0) return tlv(TAG.INTEGER, Uint8Array.of(0));
  const content =
    (trimmed[0] ?? 0) & 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed;
  return tlv(TAG.INTEGER, content);
}

/** A small non-negative INTEGER such as a version number. */
export function smallInteger(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`DER integer ${value} is not a non-negative integer`);
  }
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 0x100)) {
    bytes.unshift(rest % 0x100);
  }
  return unsignedInteger(Uint8Array.from(bytes));
}

/** Base-128 with the continuation bit on every byte but the last. */
function base128(value: number): number[] {
  const out = [value % 0x80];
  for (let rest = Math.floor(value / 0x80); rest > 0; ) {
    out.unshift(0x80 | (rest % 0x80));
    rest = Math.floor(rest / 0x80);
  }
  return out;
}

/** An OBJECT IDENTIFIER from dotted decimal, e.g. `2.5.4.3`. */
export function objectIdentifier(dotted: string): Uint8Array {
  if (!/^[0-2](\.(0|[1-9]\d*))+$/.test(dotted)) {
    throw new RangeError(`"${dotted}" is not a dotted object identifier`);
  }
  const arcs = dotted.split(".").map(Number);
  const [first = 0, second = 0, ...rest] = arcs;
  if (first < 2 && second > 39) {
    throw new RangeError(`"${dotted}" has a second arc above 39`);
  }
  if (arcs.some((arc) => !Number.isSafeInteger(arc))) {
    throw new RangeError(`"${dotted}" has an arc too large to encode`);
  }
  const body = [first * 40 + second, ...rest].flatMap(base128);
  return tlv(TAG.OBJECT_IDENTIFIER, Uint8Array.from(body));
}

export function utf8String(text: string): Uint8Array {
  return tlv(TAG.UTF8_STRING, new TextEncoder().encode(text));
}

export function octetString(bytes: Uint8Array): Uint8Array {
  return tlv(TAG.OCTET_STRING, bytes);
}

/** A BIT STRING of whole bytes (a key, a signature): zero unused bits. */
export function bitString(bytes: Uint8Array): Uint8Array {
  return tlv(TAG.BIT_STRING, concat([Uint8Array.of(0), bytes]));
}

/**
 * A named bit list (KeyUsage): bit 0 is the most significant bit of the
 * first byte, and DER drops every trailing zero bit, counting the dropped
 * bits of the last byte as unused.
 */
export function namedBits(bits: readonly number[]): Uint8Array {
  if (bits.some((bit) => !Number.isSafeInteger(bit) || bit < 0)) {
    throw new RangeError("named bits must be non-negative integers");
  }
  if (bits.length === 0) return tlv(TAG.BIT_STRING, Uint8Array.of(0));
  const highest = Math.max(...bits);
  const bytes = new Uint8Array(Math.floor(highest / 8) + 1);
  for (const bit of bits) {
    const index = Math.floor(bit / 8);
    bytes[index] = (bytes[index] ?? 0) | (0x80 >> (bit % 8));
  }
  const unused = 7 - (highest % 8);
  return tlv(TAG.BIT_STRING, concat([Uint8Array.of(unused), bytes]));
}

export function boolean(value: boolean): Uint8Array {
  return tlv(TAG.BOOLEAN, Uint8Array.of(value ? 0xff : 0x00));
}

const two = (value: number) => String(value).padStart(2, "0");

/**
 * An RFC 5280 §4.1.2.5 Time: UTCTime (YYMMDDHHMMSSZ) for 1950 through 2049,
 * GeneralizedTime (YYYYMMDDHHMMSSZ) otherwise, always in UTC with whole
 * seconds. Milliseconds are dropped, never rounded up.
 */
export function time(date: Date): Uint8Array {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("DER time is not a date");
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) {
    throw new RangeError(`DER time year ${year} is outside 0000-9999`);
  }
  const rest = [
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ]
    .map(two)
    .join("");
  const ascii = (text: string) => new TextEncoder().encode(text);
  if (year >= 1950 && year <= 2049) {
    return tlv(TAG.UTC_TIME, ascii(`${two(year % 100)}${rest}Z`));
  }
  return tlv(
    TAG.GENERALIZED_TIME,
    ascii(`${String(year).padStart(4, "0")}${rest}Z`),
  );
}

/** A constructed context-specific tag `[n] EXPLICIT` around one value. */
export function explicit(tagNumber: number, content: Uint8Array): Uint8Array {
  return tlv(0xa0 | tagNumber, content);
}

/** A primitive context-specific tag `[n] IMPLICIT` over raw content octets. */
export function implicit(tagNumber: number, content: Uint8Array): Uint8Array {
  return tlv(0x80 | tagNumber, content);
}

/** PEM armour: base64 in 64-character lines between BEGIN/END labels. */
export function toPem(der: Uint8Array, label: string): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines: string[] = [];
  for (let at = 0; at < base64.length; at += 64) {
    lines.push(base64.slice(at, at + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
