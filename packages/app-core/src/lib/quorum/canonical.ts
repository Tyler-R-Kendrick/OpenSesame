/**
 * Canonical JSON and the framed digest every quorum approval is bound to.
 *
 * The rules follow the interaction request digest (ADR 0086,
 * `packages/os-domain/src/crypto/request-digest.ts`) because they are the same
 * invariant: displayed operation == approved operation == executed operation.
 *
 * - Object keys are sorted by UTF-16 code unit, recursively; array order is
 *   kept. Two encoders that disagree on key order would otherwise produce two
 *   digests for one request.
 * - Only integers are numbers. A float's text depends on the encoder, and a
 *   digest cannot depend on that.
 * - Fields are length-prefixed when framed, so text moved across a field
 *   boundary does not hash the same.
 * - The purpose string is the first frame, so a digest made for one use
 *   cannot be offered for another.
 */

import { sha256 } from "@noble/hashes/sha2";
import {
  type JsonObject,
  type JsonValue,
  isBoolean,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { toHex, utf8Bytes } from "./bytes.js";

/** Plain JSON, the owner contract (`os-domain`); the digest only ever sees this. */
export type Json = JsonValue;

function canonicalObject(value: JsonObject): string {
  const entries = Object.entries(value)
    .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const members = entries.map(
    ([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`,
  );
  return `{${members.join(",")}}`;
}

export function canonicalize(value: Json): string {
  if (value === null || isBoolean(value) || isString(value)) {
    return JSON.stringify(value);
  }
  if (isNumber(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error("canonical JSON allows safe integers only");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  return canonicalObject(value);
}

/** Each field as its UTF-8 byte length in decimal, a NUL, then its bytes. */
export function frame(fields: readonly string[]): Uint8Array {
  const parts: number[] = [];
  for (const field of fields) {
    const bytes = utf8Bytes(field);
    parts.push(...utf8Bytes(`${bytes.length}\0`), ...bytes);
  }
  return Uint8Array.from(parts);
}

/** `sha256:<hex>` over the purpose and fields, framed. */
export function framedDigest(
  purpose: string,
  fields: readonly string[],
): string {
  return `sha256:${toHex(sha256(frame([purpose, ...fields])))}`;
}

/** The 32 raw bytes of a `sha256:<hex>` digest. */
export function digestBytes(digest: string): Uint8Array {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (!match?.[1]) throw new Error("not a sha256 digest");
  return Uint8Array.from(match[1].match(/../g) ?? [], (h) =>
    Number.parseInt(h, 16),
  );
}
