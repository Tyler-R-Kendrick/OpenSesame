import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * Signed/encrypted peer request+receipt verification (PEER-B).
 * Scope, audience, nonce, expiry, epoch, replay. Reject unknown algs, none,
 * SSRF, oversized, unbound headers (INV-15, INV-26, INV-29).
 */

import { PEER_BOUNDS } from "./bounds.js";
import { assertSafePeerOrigin } from "./origin.js";
export { assertSafePeerOrigin };

export type PeerEnvelope = Readonly<{
  schemaVersion: 1;
  alg: "ECDSA-P256-SHA256";
  issuer: string;
  audience: string;
  principalRef: string;
  vaultRef: string;
  deviceBindingRef: string;
  operation: string;
  incidentId: string;
  policyRevision: number;
  keyEpoch: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  /** AES-GCM ciphertext of operation payload (optional empty). */
  ciphertextB64: string;
  signatureB64: string;
}>;

export type PeerReceipt = Readonly<{
  schemaVersion: 1;
  requestNonce: string;
  recipientDeviceBinding: string;
  status: "accepted" | "rejected";
  at: string;
  signatureB64: string;
}>;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function signingInput(env: Omit<PeerEnvelope, "signatureB64">): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: env.schemaVersion,
      alg: env.alg,
      issuer: env.issuer,
      audience: env.audience,
      principalRef: env.principalRef,
      vaultRef: env.vaultRef,
      deviceBindingRef: env.deviceBindingRef,
      operation: env.operation,
      incidentId: env.incidentId,
      policyRevision: env.policyRevision,
      keyEpoch: env.keyEpoch,
      nonce: env.nonce,
      issuedAt: env.issuedAt,
      expiresAt: env.expiresAt,
      ciphertextB64: env.ciphertextB64,
    }),
  );
}

export async function generatePeerKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

export async function generatePeerWrapKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptPeerPayload(
  plaintext: Uint8Array,
  key: CryptoKey,
): Promise<string> {
  if (plaintext.byteLength > PEER_BOUNDS.payloadMaxBytes) {
    throw new Error("unsupported_factor: oversized payload");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return b64(packed);
}

export async function decryptPeerPayload(
  ciphertextB64: string,
  key: CryptoKey,
): Promise<Uint8Array> {
  const packed = fromB64(ciphertextB64);
  if (packed.byteLength > PEER_BOUNDS.payloadMaxBytes + 32) {
    throw new Error("unsupported_factor: oversized payload");
  }
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct),
  );
}

type SignInput = {
  alg?: string;
  schemaVersion?: number;
  version?: number;
  issuer: string;
  audience: string;
  principalRef: string;
  vaultRef: string;
  deviceBindingRef: string;
  operation: string;
  incidentId: string;
  policyRevision: number;
  keyEpoch: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  ciphertextB64?: string;
  /** Legacy alias used by shared duress.test.ts */
  payloadB64?: string;
  /** Reject unbound security-altering headers. */
  headers?: JsonObject;
};

export async function signPeerEnvelope(
  env: SignInput,
  privateKey: CryptoKey,
): Promise<PeerEnvelope> {
  if (env.alg === "none") {
    throw new Error("unsupported_factor: none algorithm");
  }
  if (env.alg && env.alg !== "ECDSA-P256-SHA256") {
    throw new Error("unsupported_factor: unknown alg");
  }
  if (env.headers && Object.keys(env.headers).length > 0) {
    throw new Error("unsupported_factor: unbound headers");
  }
  const ciphertextB64 = env.ciphertextB64 ?? env.payloadB64 ?? "";
  if (
    fromB64(ciphertextB64 || "").byteLength >
    PEER_BOUNDS.payloadMaxBytes + 32
  ) {
    throw new Error("unsupported_factor: oversized payload");
  }
  const issued = Date.parse(env.issuedAt);
  const expires = Date.parse(env.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued
  ) {
    throw new Error("unsupported_factor: timestamps");
  }
  if (expires - issued > PEER_BOUNDS.maxTtlMs) {
    throw new Error("unsupported_factor: ttl");
  }
  const full: Omit<PeerEnvelope, "signatureB64"> = {
    schemaVersion: 1,
    alg: "ECDSA-P256-SHA256",
    issuer: env.issuer,
    audience: env.audience,
    principalRef: env.principalRef,
    vaultRef: env.vaultRef,
    deviceBindingRef: env.deviceBindingRef,
    operation: env.operation,
    incidentId: env.incidentId,
    policyRevision: env.policyRevision,
    keyEpoch: env.keyEpoch,
    nonce: env.nonce,
    issuedAt: env.issuedAt,
    expiresAt: env.expiresAt,
    ciphertextB64,
  };
  const body = signingInput(full);
  if (body.byteLength > PEER_BOUNDS.envelopeMaxBytes) {
    throw new Error("unsupported_factor: oversized envelope");
  }
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      body,
    ),
  );
  return { ...full, signatureB64: b64(sig) };
}

type PeerVerifyExpect = {
  audience: string;
  permittedOperations: readonly string[];
  vaultRef?: string;
  keyEpoch?: number;
  minPolicyRevision?: number;
  deviceBindingRef?: string;
  now?: number;
};

function verifyPeerEnvelopeHeader(
  env: PeerEnvelope,
): { ok: false; code: string } | null {
  if (env.schemaVersion !== 1)
    return { ok: false, code: "unsupported_profile_version" };
  if (env.alg !== "ECDSA-P256-SHA256")
    return { ok: false, code: "unsupported_factor" };
  return null;
}

function verifyPeerEnvelopeScope(
  env: PeerEnvelope,
  expect: PeerVerifyExpect,
): { ok: false; code: string } | null {
  if (env.audience !== expect.audience)
    return { ok: false, code: "scope_mismatch" };
  if (expect.vaultRef && env.vaultRef !== expect.vaultRef) {
    return { ok: false, code: "scope_mismatch" };
  }
  if (
    expect.deviceBindingRef &&
    env.deviceBindingRef !== expect.deviceBindingRef
  ) {
    return { ok: false, code: "scope_mismatch" };
  }
  if (expect.keyEpoch !== undefined && env.keyEpoch !== expect.keyEpoch) {
    return { ok: false, code: "stale_policy" };
  }
  if (
    expect.minPolicyRevision !== undefined &&
    env.policyRevision < expect.minPolicyRevision
  ) {
    return { ok: false, code: "stale_policy" };
  }
  if (!expect.permittedOperations.includes(env.operation)) {
    return { ok: false, code: "unavailable_authority" };
  }
  return null;
}

function verifyPeerEnvelopeFreshness(
  env: PeerEnvelope,
  expect: PeerVerifyExpect,
  seenNonces: Set<string>,
): { ok: false; code: string } | null {
  const now = expect.now ?? Date.now();
  const issued = Date.parse(env.issuedAt);
  if (Date.parse(env.expiresAt) < now)
    return { ok: false, code: "stale_session" };
  if (Number.isFinite(issued) && issued > now + PEER_BOUNDS.clockSkewMs) {
    return { ok: false, code: "stale_session" };
  }
  if (seenNonces.has(env.nonce))
    return { ok: false, code: "ambiguous_trigger" };
  if (seenNonces.size >= PEER_BOUNDS.replayCacheMax) {
    return { ok: false, code: "unsupported_factor" };
  }
  return null;
}

export async function verifyPeerEnvelope(
  env: PeerEnvelope,
  publicKey: CryptoKey,
  expect: PeerVerifyExpect,
  seenNonces: Set<string>,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const headerFailure = verifyPeerEnvelopeHeader(env);
  if (headerFailure) return headerFailure;
  const scopeFailure = verifyPeerEnvelopeScope(env, expect);
  if (scopeFailure) return scopeFailure;
  const freshnessFailure = verifyPeerEnvelopeFreshness(env, expect, seenNonces);
  if (freshnessFailure) return freshnessFailure;

  const body = signingInput({
    schemaVersion: env.schemaVersion,
    alg: env.alg,
    issuer: env.issuer,
    audience: env.audience,
    principalRef: env.principalRef,
    vaultRef: env.vaultRef,
    deviceBindingRef: env.deviceBindingRef,
    operation: env.operation,
    incidentId: env.incidentId,
    policyRevision: env.policyRevision,
    keyEpoch: env.keyEpoch,
    nonce: env.nonce,
    issuedAt: env.issuedAt,
    expiresAt: env.expiresAt,
    ciphertextB64: env.ciphertextB64,
  });
  if (body.byteLength > PEER_BOUNDS.envelopeMaxBytes) {
    return { ok: false, code: "unsupported_factor" };
  }
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    fromB64(env.signatureB64),
    body,
  );
  if (!ok) return { ok: false, code: "unavailable_authority" };
  seenNonces.add(env.nonce);
  return { ok: true };
}

export async function signPeerReceipt(
  receipt: Omit<PeerReceipt, "signatureB64" | "schemaVersion">,
  privateKey: CryptoKey,
): Promise<PeerReceipt> {
  const full = { schemaVersion: 1 as const, ...receipt };
  const body = new TextEncoder().encode(JSON.stringify(full));
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      body,
    ),
  );
  return { ...full, signatureB64: b64(sig) };
}

/** Reject SSRF-ish route targets at the pairing boundary. */

/**
 * Tailscale identity is evidence only when present — never automatic vault
 * authority; never a reason to weaken certs (PEER-E).
 */
export function tailscaleEvidenceOnly(identity: string | null | undefined):
  | {
      kind: "tailscale_evidence";
      identity: string;
      vaultAuthority: false;
      certWeakening: false;
    }
  | { kind: "absent"; vaultAuthority: false; certWeakening: false } {
  if (!identity || !identity.trim()) {
    return { kind: "absent", vaultAuthority: false, certWeakening: false };
  }
  return {
    kind: "tailscale_evidence",
    identity: identity.trim(),
    vaultAuthority: false,
    certWeakening: false,
  };
}
