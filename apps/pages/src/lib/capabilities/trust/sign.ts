/**
 * Producing side of the envelope and rotation formats (S03). Used by tests
 * and by an operator's authoring tool; the Pages runtime only verifies.
 * Signing needs a private `CryptoKey` the caller already holds — nothing here
 * generates, exports or stores private material.
 */
import type { InstanceCapabilityPolicy } from "@opensesame/capability-composition";
import { encodeBase64Url } from "./digest.js";
import {
  ENVELOPE_ALG,
  ENVELOPE_KIND,
  type EnvelopeHeader,
  type SignedPolicyEnvelope,
  envelopeSignedBytes,
  policyPayloadDigest,
} from "./envelope.js";
import {
  ECDSA_P256,
  ECDSA_SHA256,
  type PolicyKeyRotation,
  type PolicyPublicJwk,
  jwkThumbprintHex,
  policyPublicJwk,
  rotationSignedBytes,
} from "./trust-keys.js";

export type PolicySigningKey = Readonly<{
  kid: string;
  publicJwk: PolicyPublicJwk;
  privateKey: CryptoKey;
}>;

/** A fresh non-extractable P-256 pair; `kid` is the public key's thumbprint. */
export async function generatePolicySigningKey(): Promise<PolicySigningKey> {
  const pair = await crypto.subtle.generateKey(ECDSA_P256, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = policyPublicJwk({
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
  });
  if (publicJwk === null)
    throw new Error("generated key is not a P-256 public key");
  return {
    kid: await jwkThumbprintHex(publicJwk),
    publicJwk,
    privateKey: pair.privateKey,
  };
}

async function signBytes(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign(ECDSA_SHA256, key, bytes);
  return encodeBase64Url(new Uint8Array(signature));
}

export type EnvelopeInput = Readonly<{
  payload: InstanceCapabilityPolicy;
  notBefore?: string;
  expires?: string;
  allowedOrigins?: readonly string[];
}>;

export async function signPolicyEnvelope(
  key: PolicySigningKey,
  input: EnvelopeInput,
): Promise<SignedPolicyEnvelope> {
  const required: EnvelopeHeader = {
    schemaVersion: 1,
    kind: ENVELOPE_KIND,
    instanceId: input.payload.instanceId,
    revision: input.payload.revision,
    alg: ENVELOPE_ALG,
    kid: key.kid,
    payloadDigest: await policyPayloadDigest(input.payload),
  };
  // The optional members are written only when the caller gave one, so an
  // absent window is absent from the signed bytes rather than present as
  // `undefined`.
  const header: EnvelopeHeader = { ...required };
  if (input.notBefore !== undefined) header.notBefore = input.notBefore;
  if (input.expires !== undefined) header.expires = input.expires;
  if (input.allowedOrigins !== undefined)
    header.allowedOrigins = input.allowedOrigins;
  return {
    ...header,
    payload: input.payload,
    signature: await signBytes(key.privateKey, envelopeSignedBytes(header)),
  };
}

export async function signPolicyKeyRotation(
  signer: PolicySigningKey,
  input: Readonly<{
    instanceId: string;
    next: PolicySigningKey;
    retire: boolean;
    notBefore?: string;
  }>,
): Promise<PolicyKeyRotation> {
  const unsigned: Omit<PolicyKeyRotation, "signature"> = {
    schemaVersion: 1,
    kind: "PolicyKeyRotation",
    instanceId: input.instanceId,
    signedBy: signer.kid,
    kid: input.next.kid,
    key: input.next.publicJwk,
    retire: input.retire,
  };
  if (input.notBefore !== undefined) unsigned.notBefore = input.notBefore;
  return {
    ...unsigned,
    signature: await signBytes(
      signer.privateKey,
      rotationSignedBytes(unsigned),
    ),
  };
}
