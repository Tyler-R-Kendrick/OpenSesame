/**
 * Deterministic JSON canonicalization for objects we control (RFC 8785 subset).
 * Sorted keys, no insignificant whitespace. Not for arbitrary third-party JSON.
 */

import {
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { DOMAIN_CAPSULE, DOMAIN_MANIFEST } from "@opensesame/vault-core";
import { ProtectionError } from "./errors.js";

export { DOMAIN_CAPSULE, DOMAIN_MANIFEST };

function canonicalizeValue(value: JsonValue): JsonValue {
  if (value === null) return null;
  if (isBoolean(value)) return value;
  if (isNumber(value)) {
    if (!Number.isFinite(value)) {
      throw new ProtectionError(
        "malformed_encoding",
        "Canonicalization rejects non-finite numbers.",
      );
    }
    return value;
  }
  if (isString(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry));
  }
  if (!isJsonObject(value)) {
    throw new ProtectionError(
      "malformed_encoding",
      "Canonicalization rejects unsupported value types.",
    );
  }
  const keys = Object.keys(value).sort();
  const out: JsonObject = {};
  for (const key of keys) {
    const entry = value[key];
    if (entry === undefined) continue;
    out[key] = canonicalizeValue(entry);
  }
  return out;
}

/** UTF-8 bytes of sorted-key JSON without insignificant whitespace. */
export function canonicalizeToBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalizeValue(value)));
}

export function canonicalizeToString(value: JsonValue): string {
  return new TextDecoder().decode(canonicalizeToBytes(value));
}

/** Domain-tagged bytes: `label\\0` + canonical JSON. */
export function domainCanonicalBytes(
  domain: typeof DOMAIN_MANIFEST | typeof DOMAIN_CAPSULE,
  value: JsonValue,
): Uint8Array {
  const body = canonicalizeToBytes(value);
  const prefix = new TextEncoder().encode(`${domain}\0`);
  const out = new Uint8Array(prefix.byteLength + body.byteLength);
  out.set(prefix, 0);
  out.set(body, prefix.byteLength);
  return out;
}
