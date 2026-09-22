/**
 * Canonical JSON normalization and a deterministic FNV-1a digest.
 *
 * ⚠️ NOT A SECURITY BOUNDARY. The FNV-1a 64-bit digest implemented here is a
 * **change-detector and ordering/compare identity only**: two identical
 * canonical forms produce identical digests, and any change to the canonical
 * form almost certainly changes the digest. It is not an integrity proof, not
 * a signature, and not collision-resistant — an adversary can construct
 * colliding inputs cheaply, so nothing here may gate trust. Cryptographic
 * commitment (e.g. WebAuthn `boundDigest`, sealed-store digests) is produced
 * elsewhere with real hash functions; consumers feed those the *canonical
 * string* this module emits.
 *
 * Canonical form: object keys sorted (code-unit order), arrays kept in the
 * order given (callers sort semantically-ordered collections before
 * digesting), numbers rendered via their shortest round-trip form with
 * non-finite values rejected, `undefined` object fields dropped, and
 * `undefined` array slots and functions/symbols rejected.
 */
import type { BoundaryValue, JsonValue } from "@opensesame/os-domain";
import {
  isBigint,
  isFunction,
  isNumber,
  isString,
} from "@opensesame/os-domain";

/**
 * The canonical JSON text for a boundary value, or `undefined` when the value
 * cannot be canonicalized (functions, symbols, non-finite numbers, `undefined`
 * where a value is required).
 */
export function canonicalJson(value: BoundaryValue): string | undefined {
  return canonicalize(value);
}

function canonicalize(value: BoundaryValue): string | undefined {
  if (value === null) return "null";
  if (isString(value)) return JSON.stringify(value);
  if (value === true) return "true";
  if (value === false) return "false";
  if (isNumber(value)) return canonicalNumber(value);
  if (isBigint(value)) return undefined;
  if (Array.isArray(value)) return canonicalArray(value);
  if (value instanceof Date) return undefined;
  if (value instanceof Uint8Array) return undefined;
  if (value instanceof ArrayBuffer) return undefined;
  if (value instanceof Map) return undefined;
  if (value instanceof Set) return undefined;
  if (value instanceof Error) return undefined;
  if (isFunction(value)) return undefined;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, BoundaryValue>);
    const parts: string[] = [];
    for (const [key, member] of entries) {
      if (member === undefined) continue; // dropped: absent ≡ undefined
      const encoded = canonicalize(member);
      if (encoded === undefined) return undefined;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    parts.sort(compareEntries);
    return `{${parts.join(",")}}`;
  }
  return undefined; // symbols and anything else
}

function canonicalArray(value: readonly BoundaryValue[]): string | undefined {
  const parts: string[] = [];
  for (const member of value) {
    const encoded = canonicalize(member);
    if (encoded === undefined) return undefined;
    parts.push(encoded);
  }
  return `[${parts.join(",")}]`;
}

function canonicalNumber(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (Number.isInteger(value)) return String(value); // no ".0" drift
  return String(value); // shortest round-trip in every modern engine
}

function compareEntries(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * FNV-1a 64-bit over the UTF-8 bytes of `text`, rendered as 16 lowercase hex
 * digits. Deterministic across processes; not cryptographic.
 */
export function fnv1a64Hex(text: string): string {
  let hash = 0xcbf29ce484222325n; // FNV offset basis, 64-bit
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Digest a value by canonicalizing it first; `undefined` when the value has no
 * canonical form. Same caveats as `fnv1a64Hex`: ordering identity, not proof.
 */
export function digestCanonical(value: BoundaryValue): string | undefined {
  const canonical = canonicalJson(value);
  return canonical === undefined ? undefined : fnv1a64Hex(canonical);
}

/** True when two values share the same canonical form (structure equal). */
export function canonicalEquals(
  a: BoundaryValue,
  b: BoundaryValue,
): boolean | undefined {
  const left = canonicalJson(a);
  const right = canonicalJson(b);
  return left === undefined || right === undefined ? undefined : left === right;
}

/** Type helper: any value that can flow into the digest pipeline. */
export type CanonicalInput = JsonValue | BoundaryValue;
