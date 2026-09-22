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
import {
  type BoundaryValue,
  type JsonValue,
  isBigint,
  isFunction,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";

/**
 * The canonical JSON text for a boundary value, or `undefined` when the value
 * cannot be canonicalized (functions, symbols, non-finite numbers, `undefined`
 * where a value is required).
 *
 * Accepts unknown because hostile fixtures arrive untyped; non-JSON shapes
 * are refused at runtime with `undefined`, never thrown.
 */
export function canonicalJson(value: unknown): string | undefined {
  if (!isJsonValueLike(value)) return undefined;
  return canonicalize(value);
}

function canonicalize(value: JsonValue): string | undefined {
  if (value === null) return "null";
  if (isString(value)) return JSON.stringify(value);
  if (value === true) return "true";
  if (value === false) return "false";
  if (isNumber(value)) return canonicalNumber(value);
  if (isBigint(value)) return undefined;
  if (Array.isArray(value)) return canonicalArray(value);
  if (
    value instanceof Date ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Error ||
    isFunction(value)
  ) {
    return undefined;
  }
  if (isJsonObject(value)) {
    const parts: string[] = [];
    for (const [key, member] of Object.entries(value)) {
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

function canonicalArray(value: readonly JsonValue[]): string | undefined {
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
 *
 * Accepts unknown because plans and hostile fixtures arrive untyped; the
 * canonicalizer validates structure at runtime and refuses what it cannot
 * encode, so no caller assertion is needed.
 */
export function digestCanonical(value: unknown): string | undefined {
  if (!isJsonValueLike(value)) return undefined;
  const canonical = canonicalJson(value);
  return canonical === undefined ? undefined : fnv1a64Hex(canonical);
}

/** JSON-shaped inputs only; undefined members are dropped, not refused. */
function isJsonValueLike(value: unknown): value is JsonValue {
  if (value === undefined) return true;
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "number") return true;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValueLike);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValueLike);
}

/** Plain records only — arrays, null, and primitives handled above. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** True when two values share the same canonical form (structure equal). */
export function canonicalEquals(a: unknown, b: unknown): boolean | undefined {
  const left = canonicalJson(a);
  const right = canonicalJson(b);
  return left === undefined || right === undefined ? undefined : left === right;
}

/** Type helper: any value that can flow into the digest pipeline. */
export type CanonicalInput = JsonValue | BoundaryValue;
