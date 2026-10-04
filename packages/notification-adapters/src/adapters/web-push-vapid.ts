/**
 * RFC 8292 VAPID for Web Push, on `node:crypto`: the application server's
 * identity, the ES256 token that proves it, and key generation.
 *
 * Split out of `web-push.ts`; the package index re-exports it all.
 */

import { createECDH, createPrivateKey, createSign } from "node:crypto";

import { base64UrlDecode, base64UrlEncode, utf8 } from "../bytes.js";
import { P256_UNCOMPRESSED_LENGTH } from "./web-push-ece.js";

/** RFC 8292 caps a VAPID token at 24 hours; half that is plenty. */
export const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

/** The application server identity a push service checks (RFC 8292). */
export interface VapidIdentity {
  /** base64url uncompressed P-256 point, 65 bytes. */
  vapidPublicKey: string;
  /** base64url private scalar, 32 bytes. Never leaves this process. */
  vapidPrivateKey: string;
  /** `mailto:` or `https:` contact, per RFC 8292 §2.1. */
  vapidSubject: string;
}

/**
 * Does this configuration name a usable application server identity: a contact
 * (RFC 8292 §2.1), a P-256 public point, and the private scalar that belongs
 * to it? A pair that does not match signs tokens no push service will accept
 * under the key the browser subscribed to, so it is unconfigured rather than
 * "configured and failing".
 */
export function vapidConfigured(config: VapidIdentity): boolean {
  if (!/^(?:mailto:|https:)\S+$/u.test(config.vapidSubject)) return false;
  const pub = base64UrlDecode(config.vapidPublicKey);
  const priv = base64UrlDecode(config.vapidPrivateKey);
  if (
    pub.length !== P256_UNCOMPRESSED_LENGTH ||
    pub[0] !== 0x04 ||
    priv.length === 0 ||
    priv.length > 32
  ) {
    return false;
  }
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(padScalar(priv));
    return ecdh.getPublicKey().equals(pub);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * RFC 8292 VAPID
 * ------------------------------------------------------------------ */

function jwtSegment(value: Uint8Array): string {
  return base64UrlEncode(value);
}

/**
 * Turn an ASN.1 DER ECDSA signature into the raw `r || s` JWS wants.
 *
 * `createSign` emits DER — a SEQUENCE of two INTEGERs — and JWS ES256 wants
 * 64 fixed-width bytes. The conversion is where this normally goes wrong:
 * DER INTEGERs are signed, so a value whose high bit is set gains a leading
 * zero byte, and a small value loses leading zeros entirely. Both must be
 * re-padded to exactly 32 bytes, or the push service rejects a signature
 * that is arithmetically correct.
 */
export function derToRawEcdsaSignature(der: Uint8Array): Buffer {
  const bytes = Buffer.from(der);
  let offset = 0;
  if (bytes[offset] !== 0x30) throw new Error("ECDSA DER: no SEQUENCE");
  offset += 1;
  const seqLength = bytes[offset] ?? 0;
  // Long-form length, which a 64-byte signature never needs but a parser
  // must still refuse rather than mis-read.
  offset += seqLength < 0x80 ? 1 : 1 + (seqLength & 0x7f);

  const readInteger = (): Buffer => {
    if (bytes[offset] !== 0x02) throw new Error("ECDSA DER: no INTEGER");
    offset += 1;
    const length = bytes[offset] ?? 0;
    offset += 1;
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };

  const r = readInteger();
  const s = readInteger();
  const out = Buffer.alloc(64);
  // Right-aligned: a 31-byte value is left-padded, a 33-byte one has its
  // DER sign byte dropped.
  r.subarray(Math.max(0, r.length - 32)).copy(out, 32 - Math.min(32, r.length));
  s.subarray(Math.max(0, s.length - 32)).copy(out, 64 - Math.min(32, s.length));
  return out;
}

/**
 * A P-256 scalar is 32 octets. Node's `getPrivateKey()` and several key
 * generators drop leading zero bytes, and a JWK `d` that is 31 octets long
 * is rejected outright — so the value is re-padded rather than trusted to
 * arrive the right width.
 */
function padScalar(scalar: Uint8Array): Buffer {
  const out = Buffer.alloc(32);
  Buffer.from(scalar).copy(out, 32 - Math.min(32, scalar.length));
  return out;
}

/** Build the P-256 private key from the raw scalar plus the public point. */
function vapidPrivateKeyObject(config: VapidIdentity) {
  const pub = base64UrlDecode(config.vapidPublicKey);
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: base64UrlEncode(padScalar(base64UrlDecode(config.vapidPrivateKey))),
      x: base64UrlEncode(pub.subarray(1, 33)),
      y: base64UrlEncode(pub.subarray(33, 65)),
    },
    format: "jwk",
  });
}

/**
 * The `Authorization: vapid t=..., k=...` header of RFC 8292 §3.
 *
 * `aud` is the *origin* of the endpoint and not the endpoint itself: a token
 * scoped to the full path would be a token scoped to one subscription, and
 * push services reject it. Scoping it to the origin is what stops a token
 * captured by one push service from being replayed against another.
 */
export function vapidAuthorization(
  endpoint: string,
  config: VapidIdentity,
  at: Date,
): string {
  const audience = new URL(endpoint).origin;
  const header = jwtSegment(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = jwtSegment(
    utf8(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(at.getTime() / 1000) + VAPID_TOKEN_LIFETIME_SECONDS,
        sub: config.vapidSubject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const der = createSign("SHA256")
    .update(utf8(signingInput))
    .sign(vapidPrivateKeyObject(config));
  const jwt = `${signingInput}.${jwtSegment(derToRawEcdsaSignature(der))}`;
  return `vapid t=${jwt}, k=${config.vapidPublicKey}`;
}

/** base64url halves of a P-256 application-server key pair. */
export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

/** Generate a VAPID key pair. Used by operators once, and by the tests. */
export function generateVapidKeyPair(): VapidKeyPair {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: base64UrlEncode(ecdh.getPublicKey()),
    privateKey: base64UrlEncode(padScalar(ecdh.getPrivateKey())),
  };
}
