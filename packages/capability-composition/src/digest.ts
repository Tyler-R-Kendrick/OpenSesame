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
  isBigint,
  isBoolean,
  isFunction,
  isNumber,
  isString,
  isTypeofObject,
} from "@opensesame/os-domain";

/**
 * Anything a caller may hand to the digest pipeline: every boundary value,
 * every validated domain record (descriptors, policies, plans), plus the
 * hostile function shape the canonicalizer refuses with `undefined`.
 * Non-JSON shapes are refused at runtime, never thrown.
 *
 * `BoundaryValue` is os-domain's own boundary union; the record and array
 * arms widen it recursively — not to `BoundaryValue` at each level — so
 * nested plans, descriptor lists, and capability entries stay in contract
 * at every depth.
 */
export type DigestInput =
  | BoundaryValue
  | DigestFunction
  | { readonly [key: string]: DigestInput | undefined }
  | { [key: string]: DigestInput | undefined }
  | readonly DigestInput[]
  | DigestInput[];

/** A hostile function value the canonicalizer refuses with `undefined`. */
export type DigestFunction = (...args: never[]) => BoundaryValue;

/**
 * The canonical JSON text for a digest input, or `undefined` when the value
 * cannot be canonicalized (functions, symbols, non-finite numbers, `undefined`
 * where a value is required).
 */
export function canonicalJson(value: DigestInput): string | undefined {
  if (!isDigestJson(value)) return undefined;
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
  if (isDigestRecord(value)) {
    // SAFETY: isDigestRecord already established the plain-object boundary
    // contract at runtime; the entries view preserves that same contract.
    const entries = Object.entries(value as Record<string, DigestInput>);
    const parts: string[] = [];
    for (const [key, member] of entries) {
      if (member === undefined) continue; // dropped: absent ≡ undefined
      if (!isDigestJson(member)) return undefined;
      const encoded = canonicalize(member);
      if (encoded === undefined) return undefined;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    parts.sort(compareEntries);
    return `{${parts.join(",")}}`;
  }
  // Date, Map, Set, Error, functions, symbols, class instances: no canonical
  // form, so the digest refuses the whole value via the caller-side guard.
  return undefined;
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
export function digestCanonical(value: DigestInput): string | undefined {
  if (!isDigestJson(value)) return undefined;
  const canonical = canonicalJson(value);
  return canonical === undefined ? undefined : fnv1a64Hex(canonical);
}

/** True when the input is composed only of JSON-compatible leaves. */
function isDigestJson(value: DigestInput): value is BoundaryValue {
  if (value === undefined || value === null) return true;
  if (isDigestString(value)) return true;
  if (isDigestNumber(value)) return true;
  if (isDigestBoolean(value)) return true;
  if (Array.isArray(value)) {
    // SAFETY: Array.isArray established the array boundary contract at
    // runtime; the readonly view preserves that same contract.
    return (value as readonly DigestInput[]).every(isDigestJson);
  }
  if (isDigestFunction(value)) return false;
  if (!isDigestRecord(value)) return false;
  return Object.values(value).every(isDigestJson);
}

/**
 * Guards below take `BoundaryValue`; these shims accept the wider digest arm.
 * Each narrows `DigestInput` through the os-domain guard's own contract,
 * never a fresh `typeof` at the call site.
 */
function isDigestString(value: DigestInput): value is string {
  return (
    // SAFETY: isTypeofObject established the boundary contract at runtime;
    // the BoundaryValue view preserves that same validated contract.
    !isTypeofObject(value as BoundaryValue) &&
    !Array.isArray(value) &&
    value !== null &&
    isString(value as BoundaryValue)
  );
}

/** Same as `isDigestString`, for numbers. */
function isDigestNumber(value: DigestInput): value is number {
  return (
    // SAFETY: isTypeofObject established the boundary contract at runtime;
    // the BoundaryValue view preserves that same validated contract.
    !isTypeofObject(value as BoundaryValue) &&
    !Array.isArray(value) &&
    value !== null &&
    isNumber(value as BoundaryValue)
  );
}

/** Same as `isDigestString`, for booleans. */
function isDigestBoolean(value: DigestInput): value is boolean {
  return (
    // SAFETY: isTypeofObject established the boundary contract at runtime;
    // the BoundaryValue view preserves that same validated contract.
    !isTypeofObject(value as BoundaryValue) &&
    !Array.isArray(value) &&
    value !== null &&
    isBoolean(value as BoundaryValue)
  );
}

/** Same as `isDigestString`, for functions (refused, never encoded). */
function isDigestFunction(value: DigestInput): value is DigestFunction {
  // SAFETY: isFunction established the function boundary contract at
  // runtime; the DigestFunction view preserves that same contract.
  return isFunction(value as BoundaryValue);
}

/** JSON-shaped inputs only; undefined members are dropped, not refused. */
function isJsonValueLike(value: BoundaryValue): value is BoundaryValue {
  if (value === undefined) return true;
  if (value === null) return true;
  if (isString(value)) return true;
  if (isNumber(value)) return true;
  if (isBoolean(value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValueLike);
  if (!isDigestRecord(value)) return false;
  return Object.values(value).every(isJsonValueLike);
}

/** Plain records only — arrays, null, and primitives handled above. */
function isDigestRecord(value: DigestInput): value is BoundaryValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** True when two values share the same canonical form (structure equal). */
export function canonicalEquals(
  a: DigestInput,
  b: DigestInput,
): boolean | undefined {
  const left = canonicalJson(a);
  const right = canonicalJson(b);
  return left === undefined || right === undefined ? undefined : left === right;
}

/** Type helper: any value that can flow into the digest pipeline. */
export type CanonicalInput = DigestInput;
