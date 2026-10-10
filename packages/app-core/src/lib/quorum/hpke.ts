/**
 * Hybrid Public Key Encryption, RFC 9180, base mode, with the one KEM and KDF
 * a browser can run without a wasm blob: DHKEM(X25519, HKDF-SHA256) and
 * HKDF-SHA256, paired with AES-128-GCM or ChaCha20-Poly1305.
 *
 * It is how a guardian hands a released share to the recipient the request
 * named: only that recipient's key opens it, and the request digest rides in
 * the AAD so a ciphertext cannot be lifted into another request (ADR 0186).
 * `hpke.test.ts` checks every intermediate value against RFC 9180 Appendix A.1
 * and A.2.
 */

import { gcm } from "@noble/ciphers/aes";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

export type HpkeAead = "aes-128-gcm" | "chacha20-poly1305";

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = {
  "aes-128-gcm": 0x0001,
  "chacha20-poly1305": 0x0003,
} satisfies Readonly<Record<HpkeAead, number>>;
const KEY_LENGTH = {
  "aes-128-gcm": 16,
  "chacha20-poly1305": 32,
} satisfies Readonly<Record<HpkeAead, number>>;
const NONCE_LENGTH = 12;
const HASH_LENGTH = 32;
const KEY_PAIR_LENGTH = 32;
const MODE_BASE = 0;

const text = new TextEncoder();
const VERSION = text.encode("HPKE-v1");

export class HpkeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HpkeError";
  }
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function i2osp(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return out;
}

const kemSuite = (): Uint8Array => concat(text.encode("KEM"), i2osp(KEM_ID, 2));

const hpkeSuite = (aead: HpkeAead): Uint8Array =>
  concat(
    text.encode("HPKE"),
    i2osp(KEM_ID, 2),
    i2osp(KDF_ID, 2),
    i2osp(AEAD_ID[aead], 2),
  );

function labeledExtract(
  suite: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
): Uint8Array {
  return extract(sha256, concat(VERSION, suite, text.encode(label), ikm), salt);
}

function labeledExpand(
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return expand(
    sha256,
    prk,
    concat(i2osp(length, 2), VERSION, suite, text.encode(label), info),
    length,
  );
}

const EMPTY = new Uint8Array(0);

export type HpkeKeyPair = Readonly<{
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}>;

export function generateKeyPair(): HpkeKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** DeriveKeyPair(ikm), RFC 9180 section 7.1.3. Deterministic; for tests and vectors. */
export function deriveKeyPair(ikm: Uint8Array): HpkeKeyPair {
  const suite = kemSuite();
  const prk = labeledExtract(suite, EMPTY, "dkp_prk", ikm);
  const secretKey = labeledExpand(suite, prk, "sk", EMPTY, KEY_PAIR_LENGTH);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

function diffieHellman(secretKey: Uint8Array, publicKey: Uint8Array) {
  if (publicKey.length !== KEY_PAIR_LENGTH) {
    throw new HpkeError("an X25519 public key is 32 bytes");
  }
  const shared = x25519.getSharedSecret(secretKey, publicKey);
  // RFC 9180 section 7.1.4: an all-zero output means a low-order point.
  if (shared.every((byte) => byte === 0)) {
    throw new HpkeError("the Diffie-Hellman output is all zero");
  }
  return shared;
}

function sharedSecretOf(
  dh: Uint8Array,
  enc: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  const suite = kemSuite();
  const prk = labeledExtract(suite, EMPTY, "eae_prk", dh);
  return labeledExpand(
    suite,
    prk,
    "shared_secret",
    concat(enc, recipientPublicKey),
    HASH_LENGTH,
  );
}

export type HpkeSchedule = Readonly<{
  key: Uint8Array;
  baseNonce: Uint8Array;
  exporterSecret: Uint8Array;
}>;

/** KeySchedule(base, shared_secret, info), RFC 9180 section 5.1. */
export function keySchedule(
  aead: HpkeAead,
  sharedSecret: Uint8Array,
  info: Uint8Array,
): HpkeSchedule {
  const suite = hpkeSuite(aead);
  const pskIdHash = labeledExtract(suite, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(suite, EMPTY, "info_hash", info);
  const context = concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = labeledExtract(suite, sharedSecret, "secret", EMPTY);
  return {
    key: labeledExpand(suite, secret, "key", context, KEY_LENGTH[aead]),
    baseNonce: labeledExpand(
      suite,
      secret,
      "base_nonce",
      context,
      NONCE_LENGTH,
    ),
    exporterSecret: labeledExpand(suite, secret, "exp", context, HASH_LENGTH),
  };
}

/** The nonce for message number `sequence`: base_nonce XOR I2OSP(seq, Nn). */
export function nonceAt(schedule: HpkeSchedule, sequence: number): Uint8Array {
  const counter = i2osp(sequence, NONCE_LENGTH);
  return schedule.baseNonce.map((byte, i) => byte ^ (counter[i] ?? 0));
}

function cipherFor(
  aead: HpkeAead,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
) {
  return aead === "aes-128-gcm"
    ? gcm(key, nonce, aad)
    : chacha20poly1305(key, nonce, aad);
}

/** The sender's side of one HPKE context. Each `seal` uses the next nonce. */
export class HpkeSender {
  private sequence = 0;
  constructor(
    readonly aead: HpkeAead,
    readonly schedule: HpkeSchedule,
    readonly sharedSecret: Uint8Array,
  ) {}

  seal(aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const nonce = nonceAt(this.schedule, this.sequence);
    const out = cipherFor(this.aead, this.schedule.key, nonce, aad).encrypt(
      plaintext,
    );
    this.sequence += 1;
    return out;
  }
}

/** The recipient's side. Messages must be opened in the order they were sealed. */
export class HpkeRecipient {
  private sequence = 0;
  constructor(
    readonly aead: HpkeAead,
    readonly schedule: HpkeSchedule,
    readonly sharedSecret: Uint8Array,
  ) {}

  open(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const nonce = nonceAt(this.schedule, this.sequence);
    let plaintext: Uint8Array;
    try {
      plaintext = cipherFor(this.aead, this.schedule.key, nonce, aad).decrypt(
        ciphertext,
      );
    } catch {
      throw new HpkeError("the ciphertext did not authenticate");
    }
    this.sequence += 1;
    return plaintext;
  }
}

export type SetupSender = Readonly<{ enc: Uint8Array; sender: HpkeSender }>;

/** SetupBaseS(pkR, info). Pass `ephemeral` only to reproduce a vector. */
export function setupBaseSender(input: {
  recipientPublicKey: Uint8Array;
  info: Uint8Array;
  aead?: HpkeAead;
  ephemeral?: HpkeKeyPair;
}): SetupSender {
  const aead = input.aead ?? "aes-128-gcm";
  const ephemeral = input.ephemeral ?? generateKeyPair();
  const dh = diffieHellman(ephemeral.secretKey, input.recipientPublicKey);
  const enc = ephemeral.publicKey;
  const sharedSecret = sharedSecretOf(dh, enc, input.recipientPublicKey);
  const schedule = keySchedule(aead, sharedSecret, input.info);
  return { enc, sender: new HpkeSender(aead, schedule, sharedSecret) };
}

/** SetupBaseR(enc, skR, info). */
export function setupBaseRecipient(input: {
  enc: Uint8Array;
  recipientSecretKey: Uint8Array;
  info: Uint8Array;
  aead?: HpkeAead;
}): HpkeRecipient {
  const aead = input.aead ?? "aes-128-gcm";
  const dh = diffieHellman(input.recipientSecretKey, input.enc);
  const recipientPublicKey = x25519.getPublicKey(input.recipientSecretKey);
  const sharedSecret = sharedSecretOf(dh, input.enc, recipientPublicKey);
  const schedule = keySchedule(aead, sharedSecret, input.info);
  return new HpkeRecipient(aead, schedule, sharedSecret);
}

/** Context.Export(exporterContext, L), RFC 9180 section 5.3. */
export function exportSecret(
  aead: HpkeAead,
  schedule: HpkeSchedule,
  exporterContext: Uint8Array,
  length: number,
): Uint8Array {
  return labeledExpand(
    hpkeSuite(aead),
    schedule.exporterSecret,
    "sec",
    exporterContext,
    length,
  );
}

export type HpkeSealed = Readonly<{ enc: Uint8Array; ciphertext: Uint8Array }>;

/** The single-shot Seal of RFC 9180 section 6.1. */
export function sealBase(input: {
  recipientPublicKey: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
  aead?: HpkeAead;
}): HpkeSealed {
  const { enc, sender } = setupBaseSender(input);
  return { enc, ciphertext: sender.seal(input.aad, input.plaintext) };
}

/** The single-shot Open of RFC 9180 section 6.1. */
export function openBase(input: {
  recipientSecretKey: Uint8Array;
  enc: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
  aead?: HpkeAead;
}): Uint8Array {
  return setupBaseRecipient(input).open(input.aad, input.ciphertext);
}
