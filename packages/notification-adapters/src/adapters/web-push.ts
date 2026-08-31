/**
 * W3C Push — the standards, implemented, with no push service in the middle.
 *
 * A "push provider" is an unnecessary party. The browser already handed us
 * an endpoint, a P-256 public key and an authentication secret; RFC 8291
 * says how to encrypt a payload to that pair so that only the subscriber's
 * user agent can read it, and RFC 8292 says how to sign the request so the
 * push service knows which application server sent it. Both are `node:crypto`
 * and a few hundred bytes of framing. Paying a vendor for this would mean
 * routing every authorization prompt through somebody else's infrastructure
 * to avoid writing an HKDF.
 *
 * Two properties are worth naming because they are easy to lose:
 *
 * - **The push service never sees the payload.** It sees ciphertext, a salt
 *   and an ephemeral public key. That is what makes it acceptable for the
 *   body to exist at all on a surface we do not control — and it is still
 *   rendered at `minimal`, because a decrypted push lands on a lock screen.
 * - **No credential is ever in a URL.** The VAPID JWT travels in the
 *   `Authorization` header. Endpoints end up in logs, referrers and crash
 *   reports; a signed token in one is a signed token in all of them.
 */

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes,
} from "node:crypto";

import {
  type ChannelCapabilities,
  channelCapabilities,
} from "@opensesame/os-domain";

import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  utf8,
} from "../bytes.js";
import type {
  ChannelAdapter,
  ClockLike,
  DeliveryDestination,
  DeliveryOutcome,
  FetchLike,
  PushSubscriptionRecord,
  RenderInput,
  RenderedMessage,
} from "../contract.js";
import { classifyThrown, deliveryAbortSignal, httpOutcome } from "../http.js";
import { renderNotification } from "../templates.js";

export const WEB_PUSH_PROVIDER_ID = "native_push";

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

/** RFC 8292 caps a VAPID token at 24 hours; half that is plenty. */
export const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

export interface WebPushConfig {
  /** base64url uncompressed P-256 point, 65 bytes. */
  vapidPublicKey: string;
  /** base64url private scalar, 32 bytes. Never leaves this process. */
  vapidPrivateKey: string;
  /** `mailto:` or `https:` contact, per RFC 8292 §2.1. */
  vapidSubject: string;
  fetchImpl?: FetchLike;
  now?: ClockLike;
  ttlSeconds?: number;
}

export function createWebPushAdapter(config: WebPushConfig): ChannelAdapter {
  const fetchImpl: FetchLike = config.fetchImpl ?? fetch;
  const now: ClockLike = config.now ?? (() => new Date());
  const ttl = config.ttlSeconds ?? 60;

  const isConfigured = (): boolean => {
    if (config.vapidSubject.length === 0) return false;
    const pub = base64UrlDecode(config.vapidPublicKey);
    const priv = base64UrlDecode(config.vapidPrivateKey);
    return (
      pub.length === P256_UNCOMPRESSED_LENGTH &&
      pub[0] === 0x04 &&
      priv.length > 0 &&
      priv.length <= 32
    );
  };

  const capabilities = (): ChannelCapabilities =>
    channelCapabilities("native_push");

  const render = (input: RenderInput): RenderedMessage =>
    renderNotification(input, {
      dialect: "plain",
      // A decrypted push notification is drawn on a locked screen by the
      // operating system. `minimal` is the only honest ceiling, and it is
      // passed literally so this stays true if the catalogue ever loosens.
      channelCeiling: "minimal",
    });

  const deliver = async (
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome> => {
    if (dest.channel !== "native_push") {
      return { status: "permanent", error: "destination_mismatch" };
    }
    if (!isConfigured()) {
      return { status: "unconfigured", error: "no_vapid_keys" };
    }
    const subscription = dest.subscription;
    let body: Buffer;
    let authorization: string;
    try {
      body = encryptWebPushPayload(subscription, pushPayload(msg));
      authorization = vapidAuthorization(subscription.endpoint, config, now());
    } catch (err) {
      // A malformed subscription is not worth retrying: the keys will not
      // become well-formed on their own, and the row should be re-collected
      // from the browser instead.
      return {
        status: "permanent",
        error: `subscription:${err instanceof Error ? err.name : "invalid"}`,
      };
    }
    try {
      const response = await fetchImpl(subscription.endpoint, {
        method: "POST",
        headers: {
          authorization,
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(ttl),
          urgency: "high",
        },
        body,
        signal: deliveryAbortSignal(),
      });
      // 404 and 410 mean the subscription is gone; `classifyHttpStatus`
      // already calls those permanent, which is what retires the row.
      return httpOutcome(response.status);
    } catch (err) {
      return classifyThrown(err instanceof Error ? err : undefined);
    }
  };

  // No `verifyCallback`: a push service delivers, it does not report back a
  // human action, and the os-domain catalogue says so
  // (`canReceiveAuthenticatedCallback: false`).
  return { kind: "native_push", isConfigured, capabilities, render, deliver };
}

/**
 * The JSON the service worker receives. Deliberately tiny and free of
 * identifiers: it is decrypted onto a device we do not control.
 */
function pushPayload(msg: RenderedMessage): Buffer {
  return utf8(
    JSON.stringify(
      msg.rendezvousUrl
        ? { title: msg.title, body: msg.body, url: msg.rendezvousUrl }
        : { title: msg.title, body: msg.body },
    ),
  );
}

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
function vapidPrivateKeyObject(config: WebPushConfig) {
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
  config: WebPushConfig,
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
