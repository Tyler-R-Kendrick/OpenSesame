/**
 * Signed instance-policy envelope (S03).
 *
 * The signature covers the header — everything but the payload and the
 * signature — and the header commits to the payload through `payloadDigest`.
 * Verification is ES256 (ECDSA P-256, SHA-256) over WebCrypto and nothing
 * else: an envelope naming another algorithm is refused before any key is
 * touched (TRUST-03), a kid the device does not hold is refused (TRUST-04),
 * and `now` is supplied by the caller — the clock is a fact, not something
 * this module reads (TRUST-10).
 *
 * Verification proves who signed, not whether the payload is a valid policy:
 * the caller parses `result.policy` with S01's `parseInstancePolicy` before
 * anything is resolved from it.
 */
import type { InstanceCapabilityPolicy } from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  type JsonValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { canonicalizeToBytes } from "../../vault/protection/canonicalize.js";
import { canonicalDigest, isDigest, parseIsoTime } from "./digest.js";
import { type TrustedKeySet, verifyEs256 } from "./trust-keys.js";

export const ENVELOPE_ALG = "ES256";
export const ENVELOPE_KIND = "InstanceCapabilityPolicy";
/** Longest envelope this module will look at, in JSON characters. */
export const MAX_ENVELOPE_CHARS = 64 * 1024;
const MAX_ORIGINS = 32;
const MAX_FIELD = 256;

export type SignedPolicyEnvelope = Readonly<{
  schemaVersion: 1;
  kind: typeof ENVELOPE_KIND;
  instanceId: string;
  revision: string;
  alg: typeof ENVELOPE_ALG;
  kid: string;
  payloadDigest: string;
  payload: InstanceCapabilityPolicy;
  notBefore?: string;
  expires?: string;
  allowedOrigins?: readonly string[];
  signature: string;
}>;

export type EnvelopeHeader = Omit<
  SignedPolicyEnvelope,
  "payload" | "signature"
>;

export type VerifyFailure =
  | "malformed-envelope"
  | "unsupported-alg"
  | "unknown-kid"
  | "malformed-signature"
  | "bad-signature"
  | "payload-digest-mismatch"
  | "wrong-instance"
  | "revision-mismatch"
  | "origin-not-allowed"
  | "not-yet-valid"
  | "expired";

export type VerifyResult = Readonly<
  | {
      ok: true;
      kid: string;
      payloadDigest: string;
      revision: string;
      policy: InstanceCapabilityPolicy;
    }
  | { ok: false; reason: VerifyFailure }
>;

export type VerifyOptions = Readonly<{
  trustedKeys: TrustedKeySet;
  /** The document origin the policy is being accepted on. */
  origin: string;
  /** ISO 8601. Supplied, never read from `Date.now()` here. */
  now: string;
  /** When known, the instance this installation belongs to. */
  instanceId?: string;
}>;

/** The bytes the operator signed: the header, canonical, payload excluded. */
export function envelopeSignedBytes(header: EnvelopeHeader): Uint8Array {
  return canonicalizeToBytes({
    alg: header.alg,
    allowedOrigins:
      header.allowedOrigins === undefined ? null : [...header.allowedOrigins],
    expires: header.expires ?? null,
    instanceId: header.instanceId,
    kid: header.kid,
    kind: header.kind,
    notBefore: header.notBefore ?? null,
    payloadDigest: header.payloadDigest,
    revision: header.revision,
    schemaVersion: header.schemaVersion,
  });
}

export function policyPayloadDigest(
  payload: InstanceCapabilityPolicy,
): Promise<string> {
  // SAFETY: InstanceCapabilityPolicy is a JSON document by definition (§7).
  const body: JsonValue = overlapCast(payload);
  return canonicalDigest(body);
}

function shortString(value: JsonValue | undefined): value is string {
  return isString(value) && value.length > 0 && value.length <= MAX_FIELD;
}

function readOrigins(
  value: JsonValue | undefined,
): readonly string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ORIGINS) return null;
  const origins: string[] = [];
  for (const entry of value) {
    if (!shortString(entry)) return null;
    try {
      if (new URL(entry).origin !== entry) return null;
    } catch {
      return null;
    }
    origins.push(entry);
  }
  return origins;
}

/** Every member an envelope must carry, at the type and length it must have. */
function hasEnvelopeMembers(value: Readonly<Record<string, JsonValue>>): boolean {
  return (
    value.schemaVersion === 1 &&
    value.kind === ENVELOPE_KIND &&
    shortString(value.instanceId) &&
    shortString(value.revision) &&
    shortString(value.alg) &&
    shortString(value.kid) &&
    isDigest(value.payloadDigest) &&
    isJsonObject(value.payload) &&
    shortString(value.signature) &&
    (value.notBefore === undefined || shortString(value.notBefore)) &&
    (value.expires === undefined || shortString(value.expires))
  );
}

/**
 * Structural read of an envelope. The `payload` is checked to be an object
 * naming the same instance and revision; its full validation is S01's.
 * Anything oversized, mistyped or carrying an unknown top-level member is
 * `null` (TRUST-02: a join document is never trusted for its own structure).
 */
export function readPolicyEnvelope(
  candidate: BoundaryValue | SignedPolicyEnvelope,
): SignedPolicyEnvelope | null {
  // SAFETY: a typed envelope is JSON data; it is re-checked member by member.
  const value: BoundaryValue = overlapCast(candidate);
  if (!isJsonObject(value)) return null;
  if (JSON.stringify(value).length > MAX_ENVELOPE_CHARS) return null;
  const known = new Set([
    "schemaVersion",
    "kind",
    "instanceId",
    "revision",
    "alg",
    "kid",
    "payloadDigest",
    "payload",
    "notBefore",
    "expires",
    "allowedOrigins",
    "signature",
  ]);
  if (!Object.keys(value).every((key) => known.has(key))) return null;
  if (!hasEnvelopeMembers(value)) return null;
  const allowedOrigins = readOrigins(value.allowedOrigins);
  if (allowedOrigins === null) return null;
  // SAFETY: every member was checked above. `alg` may still name a foreign
  // algorithm: the envelope stays readable so `verifyPolicyEnvelope` can
  // refuse it as `unsupported-alg` rather than as noise.
  const envelope: SignedPolicyEnvelope = overlapCast(
    allowedOrigins === undefined ? value : { ...value, allowedOrigins },
  );
  return envelope;
}

function validity(
  envelope: SignedPolicyEnvelope,
  now: number,
): VerifyFailure | null {
  const notBefore = parseIsoTime(envelope.notBefore);
  const expires = parseIsoTime(envelope.expires);
  if (envelope.notBefore !== undefined && notBefore === null)
    return "malformed-envelope";
  if (envelope.expires !== undefined && expires === null)
    return "malformed-envelope";
  if (notBefore !== null && now < notBefore) return "not-yet-valid";
  if (expires !== null && now >= expires) return "expired";
  return null;
}

export async function verifyPolicyEnvelope(
  candidate: BoundaryValue | SignedPolicyEnvelope,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const envelope = readPolicyEnvelope(candidate);
  if (envelope === null) return { ok: false, reason: "malformed-envelope" };
  // Algorithm is fixed before any key material is consulted (TRUST-03).
  if (envelope.alg !== ENVELOPE_ALG)
    return { ok: false, reason: "unsupported-alg" };
  const key = Object.hasOwn(options.trustedKeys, envelope.kid)
    ? options.trustedKeys[envelope.kid]
    : undefined;
  if (key === undefined) return { ok: false, reason: "unknown-kid" };
  const { payload, signature, ...header } = envelope;
  const verdict = await verifyEs256(
    key,
    envelopeSignedBytes(header),
    signature,
  );
  if (verdict !== "ok") return { ok: false, reason: verdict };
  if ((await policyPayloadDigest(payload)) !== envelope.payloadDigest)
    return { ok: false, reason: "payload-digest-mismatch" };
  // SAFETY: readPolicyEnvelope proved `payload` is a JSON object; only its
  // identity members are read here, and S01's parser owns the rest.
  const body: Readonly<Record<string, JsonValue | undefined>> =
    overlapCast(payload);
  if (
    body.instanceId !== envelope.instanceId ||
    (options.instanceId !== undefined &&
      options.instanceId !== envelope.instanceId)
  )
    return { ok: false, reason: "wrong-instance" };
  if (body.revision !== envelope.revision)
    return { ok: false, reason: "revision-mismatch" };
  if (
    envelope.allowedOrigins !== undefined &&
    !envelope.allowedOrigins.includes(options.origin)
  )
    return { ok: false, reason: "origin-not-allowed" };
  const now = parseIsoTime(options.now);
  if (now === null) return { ok: false, reason: "malformed-envelope" };
  const window = validity(envelope, now);
  if (window !== null) return { ok: false, reason: window };
  return {
    ok: true,
    kid: envelope.kid,
    payloadDigest: envelope.payloadDigest,
    revision: envelope.revision,
    policy: payload,
  };
}
