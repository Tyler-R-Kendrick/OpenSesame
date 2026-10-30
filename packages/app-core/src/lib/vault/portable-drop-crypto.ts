/**
 * Authenticated portable-drop packet encoding.
 *
 * The user-code verifier is PBKDF2-SHA256 via Web Crypto. The packet format
 * is this branch's own (`ospd1`). Web Crypto has no scrypt, and a fast hash
 * of the short code would not slow an offline guess.
 */

import { dropRefusal } from "@opensesame/ceremony-kit";
import {
  type BoundaryObject,
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";

/**
 * Same bearer shape as ceremony-kit `isPortableDropToken`. Duplicated so this
 * module does not import `claim-link`, which lives in the main chunk. A
 * portable chunk that imports main cannot be merged into the drop chunk.
 */
export const PORTABLE_DROP_TOKEN_PREFIX = "osc_pdrop_";
const PORTABLE_DROP_TOKEN = /^osc_pdrop_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

export function isPortableDropToken(value: string): boolean {
  return PORTABLE_DROP_TOKEN.test(value);
}

export class PortableDropFailure extends Error {
  readonly code:
    | "invalid_token"
    | "tampered"
    | "expired"
    | "locked_out"
    | "invalid_code";
  readonly attemptsLeft?: number | undefined;

  constructor(
    code: PortableDropFailure["code"],
    message: string,
    attemptsLeft?: number,
  ) {
    super(message);
    this.name = "PortableDropFailure";
    this.code = code;
    this.attemptsLeft = attemptsLeft;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function sha256Url(parts: string[]): Promise<string> {
  const joined = new TextEncoder().encode(parts.join("\0"));
  return crypto.subtle.digest("SHA-256", joined).then((digest) => {
    return bytesToB64url(new Uint8Array(digest));
  });
}

const PACKET_PREFIX = "ospd1";
const NONCE_BYTES = 12;
const SALT_BYTES = 16;
const DIGEST_BYTES = 32;
const HKDF_INFO = "opensesame.portable-drop.transport.v1";
const TOKEN_DIGEST_INFO = "opensesame.portable-drop.token.v1";
/** OWASP 2023 floor for PBKDF2-HMAC-SHA256, same as the vault password KDF. */
const CODE_KDF = "PBKDF2-SHA256";
const CODE_KDF_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type PortableBearer = {
  claimId: string;
  secret: Uint8Array<ArrayBuffer>;
  secretText: string;
};

export type DecodedPortableDrop = {
  claimId: string;
  manifest: JsonObject;
  expiresAtMs: number;
  codeSalt: Uint8Array;
  userCodeDigest: string;
  codeKdf: {
    algorithm: typeof CODE_KDF;
    iterations: typeof CODE_KDF_ITERATIONS;
  };
};

function invalidToken(): PortableDropFailure {
  return new PortableDropFailure(
    "invalid_token",
    dropRefusal("invalid_token", 401).words,
  );
}

function tampered(): PortableDropFailure {
  return new PortableDropFailure(
    "tampered",
    dropRefusal("invalid_token", 401).words,
  );
}

function decodeBytes(value: string, length?: number) {
  const bytes = b64urlToBytes(value);
  if (bytesToB64url(bytes) !== value)
    throw new Error("non-canonical base64url");
  if (length !== undefined && bytes.length !== length) {
    throw new Error("unexpected byte length");
  }
  return bytes;
}

function bearerFrom(token: string): PortableBearer {
  if (!isPortableDropToken(token)) throw invalidToken();
  const split = token.lastIndexOf(".");
  const claimId = token.slice(PORTABLE_DROP_TOKEN_PREFIX.length, split);
  const secretText = token.slice(split + 1);
  try {
    const secret = decodeBytes(secretText, DIGEST_BYTES);
    if (decodeBytes(claimId, 16).length !== 16) throw new Error("bad id");
    return { claimId, secret, secretText };
  } catch {
    throw invalidToken();
  }
}

function bearerDigest(secretText: string): Promise<string> {
  return sha256Url([TOKEN_DIGEST_INFO, secretText]);
}

async function deriveCodeDigest(
  userCode: string,
  salt: Uint8Array,
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(userCode.trim()),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: overlapCast(salt),
      iterations: CODE_KDF_ITERATIONS,
    },
    material,
    DIGEST_BYTES * 8,
  );
  return bytesToB64url(new Uint8Array(bits));
}

async function transportKey(bearer: PortableBearer): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    bearer.secret,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(bearer.claimId),
      info: encoder.encode(HKDF_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function associatedData(claimId: string, tokenDigest: string, nonce: string) {
  return encoder.encode(
    JSON.stringify([PACKET_PREFIX, claimId, tokenDigest, nonce]),
  );
}

export async function sealPortableDropPacket(input: {
  bearerToken: string;
  manifest: JsonObject;
  expiresAtMs: number;
  userCode: string;
}): Promise<string> {
  const bearer = await bearerFrom(input.bearerToken);
  const tokenDigest = await bearerDigest(bearer.secretText);
  const codeSalt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const salt = bytesToB64url(codeSalt);
  const envelope = {
    v: 1,
    manifest: input.manifest,
    expiresAtMs: input.expiresAtMs,
    userCodeDigest: {
      algorithm: CODE_KDF,
      iterations: CODE_KDF_ITERATIONS,
      salt,
      digest: await deriveCodeDigest(input.userCode, codeSalt),
    },
  };
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const nonceText = bytesToB64url(nonce);
  const key = await transportKey(bearer);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: associatedData(bearer.claimId, tokenDigest, nonceText),
    },
    key,
    encoder.encode(JSON.stringify(envelope)),
  );
  return [
    PACKET_PREFIX,
    bearer.claimId,
    tokenDigest,
    nonceText,
    bytesToB64url(new Uint8Array(ciphertext)),
  ].join(".");
}

function readEnvelope(
  value: BoundaryValue,
  claimId: string,
): DecodedPortableDrop {
  if (!isJsonObject(value)) throw tampered();
  // SAFETY: isJsonObject proved a non-array JSON object for field reads.
  const root: BoundaryObject = overlapCast(value);
  const manifest = root.manifest;
  const digest = root.userCodeDigest;
  const expiresAtMs = root.expiresAtMs;
  if (
    root.v !== 1 ||
    !isNumber(expiresAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0 ||
    !isJsonObject(manifest) ||
    !isJsonObject(digest)
  ) {
    throw tampered();
  }
  // SAFETY: isJsonObject proved the sealed manifest and the code digest.
  const sealed: JsonObject = overlapCast(manifest);
  const code: BoundaryObject = overlapCast(digest);
  const salt = code.salt;
  const digestText = code.digest;
  if (
    code.algorithm !== CODE_KDF ||
    code.iterations !== CODE_KDF_ITERATIONS ||
    !isString(salt) ||
    !isString(digestText)
  ) {
    throw tampered();
  }
  try {
    return {
      claimId,
      manifest: sealed,
      expiresAtMs,
      codeSalt: decodeBytes(salt, SALT_BYTES),
      userCodeDigest: bytesToB64url(decodeBytes(digestText, DIGEST_BYTES)),
      codeKdf: {
        algorithm: CODE_KDF,
        iterations: CODE_KDF_ITERATIONS,
      },
    };
  } catch {
    throw tampered();
  }
}

export async function decodePortableDropPacket(
  pkt: string,
  bearerToken: string,
): Promise<DecodedPortableDrop> {
  const bearer = await bearerFrom(bearerToken);
  const parts = pkt.split(".");
  if (parts.length !== 5 || parts[0] !== PACKET_PREFIX) throw tampered();
  const claimId = parts[1] ?? "";
  const tokenDigest = parts[2] ?? "";
  const nonceText = parts[3] ?? "";
  const ciphertextText = parts[4] ?? "";
  const expectedDigest = await bearerDigest(bearer.secretText);
  if (
    !timingSafeEqual(claimId, bearer.claimId) ||
    !timingSafeEqual(tokenDigest, expectedDigest)
  ) {
    throw invalidToken();
  }
  let plaintext: string;
  try {
    const nonce = decodeBytes(nonceText, NONCE_BYTES);
    const ciphertext = decodeBytes(ciphertextText);
    if (ciphertext.length < 16) throw new Error("missing authentication tag");
    const key = await transportKey(bearer);
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: associatedData(claimId, tokenDigest, nonceText),
      },
      key,
      ciphertext,
    );
    plaintext = decoder.decode(opened);
  } catch {
    throw tampered();
  }
  try {
    // SAFETY: JSON.parse produces boundary data, checked by readEnvelope.
    const parsed: BoundaryValue = overlapCast(JSON.parse(plaintext));
    return readEnvelope(parsed, claimId);
  } catch (error) {
    if (error instanceof PortableDropFailure) throw error;
    throw tampered();
  }
}

export async function portableDropCodeMatches(
  decoded: DecodedPortableDrop,
  userCode: string,
): Promise<boolean> {
  const digest = await deriveCodeDigest(userCode, decoded.codeSalt);
  return timingSafeEqual(digest, decoded.userCodeDigest);
}
