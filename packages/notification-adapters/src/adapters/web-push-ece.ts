/**
 * RFC 8188 / RFC 8291 message encryption for Web Push, on `node:crypto`.
 *
 * Split out of `web-push.ts` so the adapter reads as an adapter; nothing here
 * knows about notifications. The adapter's package index re-exports it all.
 */

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  randomBytes,
} from "node:crypto";

import { base64UrlDecode, concatBytes, utf8 } from "../bytes.js";
import type { PushSubscriptionRecord } from "../contract.js";
import { type EndpointRefusal, endpointRefusal } from "../public-endpoint.js";

/* ------------------------------------------------------------------ *
 * RFC 8188 / RFC 8291 constants
 * ------------------------------------------------------------------ */

/** Uncompressed P-256 point: 0x04 || X(32) || Y(32). */
export const P256_UNCOMPRESSED_LENGTH = 65;
/** RFC 8291 fixes the authentication secret at 16 octets. */
export const AUTH_SECRET_LENGTH = 16;
export const SALT_LENGTH = 16;
export const AES_GCM_TAG_LENGTH = 16;
/** salt(16) || rs(4) || idlen(1); the key id follows. */
export const AES128GCM_HEADER_FIXED_LENGTH = 21;
/** One record is plenty; the value only has to exceed the padded plaintext. */
export const DEFAULT_RECORD_SIZE = 4096;

const KEY_INFO_PREFIX = "WebPush: info";
const CEK_INFO = "Content-Encoding: aes128gcm";
const NONCE_INFO = "Content-Encoding: nonce";
/** RFC 8188's delimiter for the final record. */
const LAST_RECORD_DELIMITER = 0x02;

/* ------------------------------------------------------------------ *
 * RFC 8291 message encryption
 * ------------------------------------------------------------------ */

function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Buffer {
  return createHmac("sha256", salt).update(ikm).digest();
}

/**
 * One-block HKDF-Expand. Every output here is 32 bytes or fewer, so the
 * counter never leaves 0x01 and the loop RFC 5869 describes collapses.
 */
function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  const block = createHmac("sha256", prk)
    .update(concatBytes([info, Buffer.from([0x01])]))
    .digest();
  return block.subarray(0, length);
}

export interface WebPushContentKeys {
  contentEncryptionKey: Buffer;
  nonce: Buffer;
}

/**
 * Derive the record key and nonce exactly as RFC 8291 §3.4 specifies.
 *
 * Two HKDFs, and the order of the inputs to the first one is the part that
 * silently breaks interoperability if it is wrong: the *user agent's* key
 * comes before the application server's in `key_info`, and the salt of the
 * first extract is the subscription's authentication secret rather than the
 * message salt. Both encryption and the verification decrypt below go
 * through this one function, so a mistake here cannot pass its own test.
 */
export function deriveWebPushKeys(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublicKey: Uint8Array,
  asPublicKey: Uint8Array,
  salt: Uint8Array,
): WebPushContentKeys {
  const keyInfo = concatBytes([
    utf8(KEY_INFO_PREFIX),
    Buffer.from([0x00]),
    uaPublicKey,
    asPublicKey,
  ]);
  const ikm = hkdfExpand(hkdfExtract(authSecret, ecdhSecret), keyInfo, 32);
  const prk = hkdfExtract(salt, ikm);
  return {
    contentEncryptionKey: hkdfExpand(
      prk,
      concatBytes([utf8(CEK_INFO), Buffer.from([0x00])]),
      16,
    ),
    nonce: hkdfExpand(
      prk,
      concatBytes([utf8(NONCE_INFO), Buffer.from([0x00])]),
      12,
    ),
  };
}

export interface SubscriptionKeyMaterial {
  uaPublicKey: Buffer;
  authSecret: Buffer;
}

function decodeSubscriptionKeys(
  subscription: PushSubscriptionRecord,
): SubscriptionKeyMaterial {
  const uaPublicKey = base64UrlDecode(subscription.keys.p256dh);
  const authSecret = base64UrlDecode(subscription.keys.auth);
  // Length and point-format checks before any crypto: `computeSecret` on a
  // short or compressed point throws from inside OpenSSL, and an error from
  // there is much harder to classify than one raised here.
  if (
    uaPublicKey.length !== P256_UNCOMPRESSED_LENGTH ||
    uaPublicKey[0] !== 0x04
  ) {
    throw new Error("subscription p256dh is not an uncompressed P-256 point");
  }
  if (authSecret.length !== AUTH_SECRET_LENGTH) {
    throw new Error("subscription auth secret must be 16 bytes");
  }
  return { uaPublicKey, authSecret };
}

/** Why a browser-supplied subscription is refused before it is stored. */
export type PushSubscriptionRefusal = EndpointRefusal | "invalid_keys";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * The registration-time check, and the one definition of a usable
 * subscription: the endpoint passes the same public-only policy delivery
 * enforces (HTTPS, no userinfo, no loopback, private or metadata host), and
 * the keys are what RFC 8291 encrypts to. A row that fails any of this can
 * never be delivered to, so it is better refused where the person can still
 * be told than retired later as a dead subscription.
 *
 * Canonical base64url only: a lenient decoder skips characters it does not
 * understand, so a value that decodes to 65 bytes is not thereby the value
 * the browser meant. The point is also run through ECDH once, which OpenSSL
 * refuses unless it lies on the P-256 curve.
 */
export function pushSubscriptionRefusal(
  subscription: PushSubscriptionRecord,
): PushSubscriptionRefusal | undefined {
  const refusal = endpointRefusal(subscription.endpoint);
  if (refusal) return refusal;
  const { p256dh, auth } = subscription.keys;
  if (!BASE64URL.test(p256dh) || !BASE64URL.test(auth)) return "invalid_keys";
  try {
    const { uaPublicKey } = decodeSubscriptionKeys(subscription);
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(uaPublicKey);
  } catch {
    return "invalid_keys";
  }
  return undefined;
}

/**
 * Encrypt one payload into a complete `aes128gcm` body.
 *
 * The header layout is fixed by RFC 8188 §2.1 and asserted by the tests:
 *
 *     salt (16) || rs (4, big-endian) || idlen (1) || keyid (idlen)
 *
 * `keyid` here is the ephemeral application-server public key, which is how
 * the user agent knows which key to run its half of the ECDH against. The
 * ephemeral key is generated per message: reusing one would make every
 * message to a subscriber share a content key.
 */
export function encryptWebPushPayload(
  subscription: PushSubscriptionRecord,
  plaintext: Uint8Array,
  saltOverride?: Uint8Array,
): Buffer {
  const { uaPublicKey, authSecret } = decodeSubscriptionKeys(subscription);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublicKey = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublicKey);
  const salt = saltOverride
    ? Buffer.from(saltOverride)
    : randomBytes(SALT_LENGTH);
  if (salt.length !== SALT_LENGTH) {
    throw new Error("aes128gcm salt must be 16 bytes");
  }

  const keys = deriveWebPushKeys(
    ecdhSecret,
    authSecret,
    uaPublicKey,
    asPublicKey,
    salt,
  );
  // The tag length is stated rather than defaulted. RFC 8291 fixes it at 16
  // bytes, and naming it here is what keeps the encrypt and decrypt sides
  // from disagreeing — a decipher that accepts a shorter tag accepts a weaker
  // forgery bound than the one this record was written under.
  const cipher = createCipheriv(
    "aes-128-gcm",
    keys.contentEncryptionKey,
    keys.nonce,
    { authTagLength: AES_GCM_TAG_LENGTH },
  );
  // The delimiter distinguishes the final record from a truncated stream;
  // without it a receiver cannot tell a complete message from one that was
  // cut short in transit.
  const padded = concatBytes([plaintext, Buffer.from([LAST_RECORD_DELIMITER])]);
  const ciphertext = concatBytes([cipher.update(padded), cipher.final()]);
  const sealed = concatBytes([ciphertext, cipher.getAuthTag()]);

  const recordSize = Math.max(
    DEFAULT_RECORD_SIZE,
    sealed.length + AES128GCM_HEADER_FIXED_LENGTH,
  );
  const header = Buffer.alloc(AES128GCM_HEADER_FIXED_LENGTH);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, SALT_LENGTH);
  header.writeUInt8(asPublicKey.length, SALT_LENGTH + 4);
  return concatBytes([header, asPublicKey, sealed]);
}

/**
 * The subscriber's half, for verification only.
 *
 * It needs the *user agent's* private key, which a server never holds — so
 * this is not a way to read anyone's traffic, it is the only way to prove
 * the encryption above is correct rather than merely self-consistent. A
 * round-trip through two independent implementations would be better; a
 * round-trip through this one at least catches a wrong info string, a
 * swapped key order, a mis-sized nonce and a mangled header.
 */
export function decryptWebPushPayload(
  body: Uint8Array,
  uaPrivateKey: Uint8Array,
  authSecret: Uint8Array,
): Buffer {
  const buffer = Buffer.from(body);
  if (buffer.length < AES128GCM_HEADER_FIXED_LENGTH) {
    throw new Error("aes128gcm body is shorter than its header");
  }
  const salt = buffer.subarray(0, SALT_LENGTH);
  const idLength = buffer.readUInt8(SALT_LENGTH + 4);
  const keyIdStart = AES128GCM_HEADER_FIXED_LENGTH;
  const asPublicKey = buffer.subarray(keyIdStart, keyIdStart + idLength);
  const sealed = buffer.subarray(keyIdStart + idLength);
  if (sealed.length <= AES_GCM_TAG_LENGTH) {
    throw new Error("aes128gcm body carries no ciphertext");
  }

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPrivateKey));
  const uaPublicKey = ecdh.getPublicKey();
  const keys = deriveWebPushKeys(
    ecdh.computeSecret(asPublicKey),
    authSecret,
    uaPublicKey,
    asPublicKey,
    salt,
  );

  const decipher = createDecipheriv(
    "aes-128-gcm",
    keys.contentEncryptionKey,
    keys.nonce,
    { authTagLength: AES_GCM_TAG_LENGTH },
  );
  decipher.setAuthTag(sealed.subarray(sealed.length - AES_GCM_TAG_LENGTH));
  const padded = concatBytes([
    decipher.update(sealed.subarray(0, sealed.length - AES_GCM_TAG_LENGTH)),
    decipher.final(),
  ]);
  // RFC 8188 allows zero padding after the delimiter, so trailing NULs are
  // discarded first and the delimiter must then be the very last byte.
  // Searching for the delimiter instead would truncate any plaintext that
  // happened to contain a 0x02.
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0x00) end -= 1;
  if (end === 0 || padded[end - 1] !== LAST_RECORD_DELIMITER) {
    throw new Error("aes128gcm record has no delimiter");
  }
  return padded.subarray(0, end - 1);
}
