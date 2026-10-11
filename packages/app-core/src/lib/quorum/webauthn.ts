/**
 * Verifying a WebAuthn assertion (W3C WebAuthn Level 3, section 7.2) for a
 * credential whose public key the policy already holds.
 *
 * A guardian's approval is an assertion over the request's phase challenge.
 * What is checked, in the order the specification gives: the client data
 * type, challenge and origin; the RP ID hash; the user-presence flag and, when
 * the policy asks, user verification; the signature counter; and the
 * signature over `authenticatorData || SHA-256(clientDataJSON)`.
 *
 * ES256 verifies through the platform's WebCrypto, which accepts the high-S
 * signatures authenticators emit. EdDSA verifies with @noble/curves.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  bytesEqual,
  concat,
  fromB64url,
  toB64url,
  utf8Bytes,
} from "./bytes.js";
import type { AssertionProof, GuardianCredential } from "./types.js";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const AUTH_DATA_MIN = 37;

export class AssertionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AssertionError";
  }
}

export type AssertionExpectations = Readonly<{
  /** The phase challenge the guardian was asked to sign. */
  challenge: Uint8Array;
  rpId: string;
  origins: readonly string[];
  requireUserVerification: boolean;
  /** The highest counter already accepted for this credential, if any. */
  lastCounter: number;
}>;

export type VerifiedAssertion = Readonly<{
  counter: number;
  userVerified: boolean;
  /** SHA-256 of the signature, for replay bookkeeping. */
  signatureDigest: string;
}>;

const ES256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** The raw key inside a SubjectPublicKeyInfo of exactly the expected shape. */
export function spkiPoint(spki: Uint8Array, alg: -7 | -8): Uint8Array {
  const prefix = alg === -7 ? ES256_SPKI_PREFIX : ED25519_SPKI_PREFIX;
  const keyLength = alg === -7 ? 65 : 32;
  const head = spki.slice(0, prefix.length);
  if (spki.length !== prefix.length + keyLength || !bytesEqual(head, prefix)) {
    throw new AssertionError(
      "bad_key",
      "the credential's public key is not a plain ES256 or Ed25519 key",
    );
  }
  return spki.slice(prefix.length);
}

/** ASN.1 DER ECDSA signature -> the 64-byte r || s WebCrypto expects. */
export function derToP1363(der: Uint8Array): Uint8Array {
  const bad = () =>
    new AssertionError("bad_signature", "malformed ECDSA signature");
  let at = 0;
  const byte = () => der[at++] ?? Number.NaN;
  if (byte() !== 0x30) throw bad();
  let length = byte();
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 2) throw bad();
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | byte();
  }
  if (length !== der.length - at) throw bad();
  const out = new Uint8Array(64);
  for (const offset of [0, 32]) {
    if (byte() !== 0x02) throw bad();
    const size = byte();
    if (!(size >= 1) || at + size > der.length) throw bad();
    let int = der.slice(at, at + size);
    at += size;
    while (int.length > 32 && int[0] === 0) int = int.slice(1);
    if (int.length > 32) throw bad();
    out.set(int, offset + 32 - int.length);
  }
  if (at !== der.length) throw bad();
  return out;
}

async function verifyEs256(
  spki: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    derToP1363(signature),
    message,
  );
}

function verifyEdDsa(
  spki: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): boolean {
  return ed25519.verify(signature, message, spkiPoint(spki, -8));
}

const ClientDataSchema = z
  .object({
    type: z.string(),
    challenge: z.string(),
    origin: z.string(),
    crossOrigin: z.boolean().optional(),
  })
  .passthrough();

function parseClientData(raw: Uint8Array): z.infer<typeof ClientDataSchema> {
  let json: BoundaryValue;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new AssertionError("client_data", "the client data is not JSON");
  }
  const parsed = ClientDataSchema.safeParse(json);
  if (!parsed.success) {
    throw new AssertionError("client_data", "the client data is malformed");
  }
  return parsed.data;
}

function checkClientData(
  raw: Uint8Array,
  expected: AssertionExpectations,
): void {
  const data = parseClientData(raw);
  if (data.type !== "webauthn.get") {
    throw new AssertionError("type", "not an authentication assertion");
  }
  if (data.challenge !== toB64url(expected.challenge)) {
    throw new AssertionError(
      "challenge",
      "the assertion signs a different request or phase",
    );
  }
  if (!expected.origins.includes(data.origin)) {
    throw new AssertionError(
      "origin",
      "the assertion came from an origin the circle does not accept",
    );
  }
  if (data.crossOrigin === true) {
    throw new AssertionError(
      "cross_origin",
      "a cross-origin assertion is refused",
    );
  }
}

type AuthenticatorFacts = Readonly<{ counter: number; userVerified: boolean }>;

function checkAuthenticatorData(
  data: Uint8Array,
  expected: AssertionExpectations,
): AuthenticatorFacts {
  if (data.length < AUTH_DATA_MIN) {
    throw new AssertionError(
      "authenticator_data",
      "authenticator data is too short",
    );
  }
  if (!bytesEqual(data.slice(0, 32), sha256(utf8Bytes(expected.rpId)))) {
    throw new AssertionError("rp_id", "the assertion is for a different RP ID");
  }
  const flags = data[32] ?? 0;
  if (!(flags & FLAG_UP)) {
    throw new AssertionError("user_presence", "the key was not touched");
  }
  const userVerified = (flags & FLAG_UV) !== 0;
  if (expected.requireUserVerification && !userVerified) {
    throw new AssertionError(
      "user_verification",
      "the policy requires a PIN or biometric",
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const counter = view.getUint32(33, false);
  // A counter that stays at zero is how synced passkeys report; one that
  // moves must keep moving, or the credential may have been cloned.
  if (counter !== 0 || expected.lastCounter !== 0) {
    if (counter <= expected.lastCounter) {
      throw new AssertionError(
        "counter",
        "the signature counter did not advance",
      );
    }
  }
  return { counter, userVerified };
}

export async function verifyAssertion(
  credential: GuardianCredential,
  proof: AssertionProof,
  expected: AssertionExpectations,
): Promise<VerifiedAssertion> {
  const clientDataJSON = fromB64url(proof.clientDataJSON);
  const authenticatorData = fromB64url(proof.authenticatorData);
  const signature = fromB64url(proof.signature);
  checkClientData(clientDataJSON, expected);
  const { counter, userVerified } = checkAuthenticatorData(
    authenticatorData,
    expected,
  );
  const signed = concat(authenticatorData, sha256(clientDataJSON));
  const spki = fromB64url(credential.publicKey);
  const valid =
    credential.alg === -7
      ? await verifyEs256(spki, signature, signed)
      : verifyEdDsa(spki, signature, signed);
  if (!valid)
    throw new AssertionError("signature", "the signature does not verify");
  return {
    counter,
    userVerified,
    signatureDigest: toB64url(sha256(signature)),
  };
}
