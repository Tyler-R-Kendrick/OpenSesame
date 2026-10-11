/**
 * RFC 9449 proof-of-possession, verified on the issuer's side (ADR 0190).
 *
 * A model key that names a key thumbprint is worth nothing to a thief who has
 * only the key: every use carries a proof signed by the thumbprint's key, for
 * this method, this URL, this key's hash and one moment. This module is the
 * whole of that check, written against `jose` for the JWS so the only code here
 * is the rules: what the header may say, what the claims must say, and that a
 * proof is spent the first time it is seen.
 *
 * The client side is `@opensesame/api-client`'s `createDpopKeyPair`.
 */
import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { sha256Base64Url } from "@opensesame/sdk-browser";
import {
  EmbeddedJWK,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  errors,
  jwtVerify,
} from "jose";
import { ModelKeyRefusal, refuse } from "./errors.js";
import { LIMITS } from "./vocabulary.js";

const MAX_AGE_SECONDS = 300;
const MAX_FUTURE_SECONDS = 60;
/** The only members a proof key may carry: a public P-256 key and nothing else. */
const JWK_MEMBERS = new Set(["kty", "crv", "x", "y"]);
const JTI = /^[A-Za-z0-9._~-]{16,128}$/;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function fail(reason: string): never {
  return refuse("invalid_dpop_proof", `dpop.${reason}`);
}

/** Remembers a proof's `jti` until it can no longer be presented, and refuses a second use. */
export class ProofReplayCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly capacity = 4096) {}

  /** Spend `key`; a key already spent, or no room to remember one, is a refusal. */
  claim(key: string, until: number, now: number): void {
    if (this.seen.size >= this.capacity / 2) this.purge(now);
    if (this.seen.has(key)) fail("replay");
    // Full of live proofs: refuse rather than forget one and let it be replayed.
    if (this.seen.size >= this.capacity) fail("cache_full");
    this.seen.set(key, until);
  }

  private purge(now: number): void {
    for (const [key, until] of this.seen)
      if (until <= now) this.seen.delete(key);
  }

  clear(): void {
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }
}

/** RFC 9449 §4.3 `ath`, and `htu`'s comparison form: no query, no fragment. */
export function accessTokenDigest(token: string): Promise<string> {
  return sha256Base64Url(token);
}

export function proofTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return fail("htu_unparsable");
  }
}

export type VerifiedProof = Readonly<{ jkt: string; jti: string }>;

export type ProofInput = Readonly<{
  proof: BoundaryValue;
  method: string;
  url: string;
  /** The key the proof travels with; its hash must be in `ath`. */
  token: string;
  now: number;
  /** When given, the proof must be signed by this thumbprint's key. */
  expectedJkt?: string;
  replay: ProofReplayCache;
}>;

/** What the proof's own `jwk` header may carry: a public P-256 key and no other member. */
function checkJwk(jwk: BoundaryValue): void {
  if (!isTypeofObject(jwk) || jwk === null) fail("jwk");
  for (const key of Object.keys(jwk))
    if (!JWK_MEMBERS.has(key)) fail("jwk_members");
  if (
    !("kty" in jwk) ||
    jwk.kty !== "EC" ||
    !("crv" in jwk) ||
    jwk.crv !== "P-256"
  )
    fail("jwk_type");
}

function embeddedKey(proof: string): void {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(proof);
  } catch {
    fail("header");
  }
  if (header.typ !== "dpop+jwt") fail("typ");
  if (header.alg !== "ES256") fail("alg");
  checkJwk(header.jwk);
}

async function verifiedPayload(
  proof: string,
  now: number,
): Promise<JsonObject> {
  try {
    const { payload } = await jwtVerify(proof, EmbeddedJWK, {
      algorithms: ["ES256"],
      typ: "dpop+jwt",
      currentDate: new Date(now),
    });
    // jose read the payload out of a JSON document, so every claim is a JSON value.
    return overlapCast(payload);
  } catch (error) {
    if (error instanceof ModelKeyRefusal) throw error;
    // `iat` is checked against our own window below, but jose refuses a
    // non-numeric one first; say which claim it was, and nothing more.
    if (error instanceof errors.JWTClaimValidationFailed)
      return fail(error.claim === "iat" ? "iat" : "claims");
    if (error instanceof errors.JWTExpired) return fail("exp");
    return fail("signature");
  }
}

/** Three dot-separated base64url segments and nothing else, within the length limit. */
function isCompactJws(proof: BoundaryValue): proof is string {
  return (
    isString(proof) &&
    proof.length > 0 &&
    proof.length <= LIMITS.maxProofLength &&
    COMPACT_JWS.test(proof)
  );
}

/** The claims that name this request (which proof, which method, which URL); answers the `jti`. */
function requestClaims(payload: JsonObject, input: ProofInput): string {
  const { jti, htm, htu } = payload;
  if (!isString(jti) || !JTI.test(jti)) return fail("jti");
  if (!isString(htm) || htm !== input.method.toUpperCase()) return fail("htm");
  if (!isString(htu) || proofTarget(htu) !== proofTarget(input.url))
    return fail("htu");
  return jti;
}

/** Is `iat` a whole number of seconds inside the window around `now`? */
function isFreshIat(iat: BoundaryValue, now: number): iat is number {
  const seconds = Math.floor(now / 1000);
  return (
    isNumber(iat) &&
    Number.isInteger(iat) &&
    iat >= seconds - MAX_AGE_SECONDS &&
    iat <= seconds + MAX_FUTURE_SECONDS
  );
}

/** The thumbprint of the key the proof carries, which must be `expected` when one is named. */
async function proofKeyThumbprint(
  proof: string,
  expected: string | undefined,
): Promise<string> {
  const { jwk } = decodeProtectedHeader(proof);
  if (!jwk) return fail("jwk");
  const jkt = await calculateJwkThumbprint(jwk, "sha256");
  if (expected !== undefined && jkt !== expected) return fail("key_mismatch");
  return jkt;
}

export async function verifyDpopProof(
  input: ProofInput,
): Promise<VerifiedProof> {
  const { proof } = input;
  if (!isCompactJws(proof)) return fail("shape");
  embeddedKey(proof);
  const payload = await verifiedPayload(proof, input.now);
  const jti = requestClaims(payload, input);
  const { iat, ath } = payload;
  if (!isFreshIat(iat, input.now)) return fail("iat");
  if (!isString(ath) || ath !== (await accessTokenDigest(input.token)))
    return fail("ath");
  const jkt = await proofKeyThumbprint(proof, input.expectedJkt);
  // Spent only now, after every other check: a refused proof is not a spent one,
  // and a thief cannot burn a victim's proofs by sending bad copies.
  input.replay.claim(
    `${jkt}:${jti}`,
    (iat + MAX_AGE_SECONDS) * 1000 + MAX_FUTURE_SECONDS * 1000,
    input.now,
  );
  return { jkt, jti };
}
