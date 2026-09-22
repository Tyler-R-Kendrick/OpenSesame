/**
 * Policy signing keys (S03): the one accepted key form, its fingerprint, and
 * key rotation that only the currently trusted key may authorize (TRUST-07).
 *
 * ECDSA P-256 with SHA-256 and nothing else. A JWK carrying a private
 * component, a different curve, a different key type or a non-ES256 `alg` is
 * not a policy key.
 */
import {
  type BoundaryValue,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { canonicalizeToBytes } from "../../vault/protection/canonicalize.js";
import {
  DIGEST_PREFIX,
  decodeBase64Url,
  parseIsoTime,
  sha256Hex,
} from "./digest.js";

export type PolicyPublicJwk = Readonly<{
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}>;

/** kid → public JWK. The kid is the key's RFC 7638 thumbprint (hex). */
export type TrustedKeySet = Readonly<Record<string, PolicyPublicJwk>>;

export const ECDSA_P256 = Object.freeze({ name: "ECDSA", namedCurve: "P-256" });
export const ECDSA_SHA256 = Object.freeze({ name: "ECDSA", hash: "SHA-256" });
const COORD_RE = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_FIELDS = new Set(["kty", "crv", "x", "y", "alg", "use", "ext", "key_ops", "kid"]);
/** ECDSA P-256 signatures are r||s, 32 bytes each, in WebCrypto and JWS alike. */
export const P256_SIGNATURE_BYTES = 64;

function metadataAllowed(value: Readonly<Record<string, JsonValue | undefined>>): boolean {
  return (
    (value.alg === undefined || value.alg === "ES256") &&
    (value.use === undefined || value.use === "sig") &&
    (value.ext === undefined || isBoolean(value.ext)) &&
    (value.key_ops === undefined ||
      (Array.isArray(value.key_ops) &&
        value.key_ops.length === 1 &&
        value.key_ops[0] === "verify"))
  );
}

/** Accept only a public P-256 JWK; a `d` member or any unknown member refuses. */
export function policyPublicJwk(value: BoundaryValue): PolicyPublicJwk | null {
  if (
    !isJsonObject(value) ||
    !Object.keys(value).every((field) => PUBLIC_FIELDS.has(field)) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    !isString(value.x) ||
    !COORD_RE.test(value.x) ||
    !isString(value.y) ||
    !COORD_RE.test(value.y) ||
    !metadataAllowed(value)
  )
    return null;
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

/** RFC 7638 thumbprint (hex): SHA-256 over `{"crv","kty","x","y"}` in that order. */
export async function jwkThumbprintHex(jwk: PolicyPublicJwk): Promise<string> {
  return sha256Hex(
    canonicalizeToBytes({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
  );
}

/** What a person compares out of band: `sha256:<thumbprint hex>`. */
export function keyFingerprint(thumbprintHex: string): string {
  return `${DIGEST_PREFIX}${thumbprintHex}`;
}

export async function importPolicyVerifyKey(
  jwk: PolicyPublicJwk,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    ECDSA_P256,
    false,
    ["verify"],
  );
}

/** ES256 verify over exact bytes; malformed signatures are `false`, never throws. */
export async function verifyEs256(
  jwk: PolicyPublicJwk,
  signedBytes: Uint8Array,
  signatureB64Url: string,
): Promise<"ok" | "malformed-signature" | "bad-signature"> {
  const signature = decodeBase64Url(signatureB64Url);
  if (signature === null || signature.byteLength !== P256_SIGNATURE_BYTES)
    return "malformed-signature";
  try {
    const key = await importPolicyVerifyKey(jwk);
    const ok = await crypto.subtle.verify(
      ECDSA_SHA256,
      key,
      signature,
      signedBytes,
    );
    return ok ? "ok" : "bad-signature";
  } catch {
    return "bad-signature";
  }
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export type PolicyKeyRotation = Readonly<{
  schemaVersion: 1;
  kind: "PolicyKeyRotation";
  instanceId: string;
  /** The kid that authorizes this rotation; must already be trusted. */
  signedBy: string;
  /** The incoming kid; must equal the thumbprint of `key`. */
  kid: string;
  key: PolicyPublicJwk;
  /** When true the authorizing key leaves the set once the new one is in. */
  retire: boolean;
  notBefore?: string;
  signature: string;
}>;

export type RotationFailure =
  | "malformed-rotation"
  | "wrong-instance"
  | "unknown-signer"
  | "kid-mismatch"
  | "self-signed"
  | "not-yet-valid"
  | "malformed-signature"
  | "bad-signature";

export type RotationResult = Readonly<
  | { ok: true; keys: TrustedKeySet; fingerprint: string }
  | { ok: false; reason: RotationFailure }
>;

/** Bytes an authorizing key signs: everything but the signature itself. */
export function rotationSignedBytes(
  rotation: Omit<PolicyKeyRotation, "signature">,
): Uint8Array {
  return canonicalizeToBytes({
    instanceId: rotation.instanceId,
    key: { crv: rotation.key.crv, kty: rotation.key.kty, x: rotation.key.x, y: rotation.key.y },
    kid: rotation.kid,
    kind: rotation.kind,
    notBefore: rotation.notBefore ?? null,
    retire: rotation.retire,
    schemaVersion: rotation.schemaVersion,
    signedBy: rotation.signedBy,
  });
}

export function readPolicyKeyRotation(
  candidate: BoundaryValue | PolicyKeyRotation,
): PolicyKeyRotation | null {
  // SAFETY: a typed rotation is JSON data; it is re-checked member by member.
  const value: BoundaryValue = overlapCast(candidate);
  if (
    !isJsonObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "PolicyKeyRotation" ||
    !isString(value.instanceId) ||
    !isString(value.signedBy) ||
    !isString(value.kid) ||
    !isBoolean(value.retire) ||
    !isString(value.signature) ||
    (value.notBefore !== undefined && !isString(value.notBefore))
  )
    return null;
  const key = policyPublicJwk(value.key);
  if (key === null) return null;
  const rotation: PolicyKeyRotation = {
    schemaVersion: 1,
    kind: "PolicyKeyRotation",
    instanceId: value.instanceId,
    signedBy: value.signedBy,
    kid: value.kid,
    key,
    retire: value.retire,
    signature: value.signature,
    ...(isString(value.notBefore) ? { notBefore: value.notBefore } : {}),
  };
  return rotation;
}

/**
 * Accept a rotation only when the currently trusted key named by `signedBy`
 * signed it, the new kid is the new key's thumbprint, and the instance
 * matches. A rotation signed by the incoming key itself is refused: trust
 * flows from what the device already holds, never from the document.
 */
export async function rotatePolicyKey(
  current: TrustedKeySet,
  candidate: BoundaryValue | PolicyKeyRotation,
  options: Readonly<{ instanceId: string; now: string }>,
): Promise<RotationResult> {
  const rotation = readPolicyKeyRotation(candidate);
  if (rotation === null) return { ok: false, reason: "malformed-rotation" };
  if (rotation.instanceId !== options.instanceId)
    return { ok: false, reason: "wrong-instance" };
  if (rotation.signedBy === rotation.kid) return { ok: false, reason: "self-signed" };
  const signer = Object.hasOwn(current, rotation.signedBy)
    ? current[rotation.signedBy]
    : undefined;
  if (signer === undefined) return { ok: false, reason: "unknown-signer" };
  const thumbprint = await jwkThumbprintHex(rotation.key);
  if (thumbprint !== rotation.kid) return { ok: false, reason: "kid-mismatch" };
  const notBefore = parseIsoTime(rotation.notBefore);
  const now = parseIsoTime(options.now);
  if (rotation.notBefore !== undefined && (notBefore === null || now === null))
    return { ok: false, reason: "malformed-rotation" };
  if (notBefore !== null && now !== null && now < notBefore)
    return { ok: false, reason: "not-yet-valid" };
  const { signature, ...unsigned } = rotation;
  const verdict = await verifyEs256(signer, rotationSignedBytes(unsigned), signature);
  if (verdict !== "ok") return { ok: false, reason: verdict };
  const keys: Record<string, PolicyPublicJwk> = {};
  for (const kid of Object.keys(current)) {
    if (rotation.retire && kid === rotation.signedBy) continue;
    keys[kid] = current[kid];
  }
  keys[rotation.kid] = rotation.key;
  return { ok: true, keys, fingerprint: keyFingerprint(thumbprint) };
}
