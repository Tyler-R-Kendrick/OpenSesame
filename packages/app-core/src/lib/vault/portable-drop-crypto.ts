/**
 * Authenticated portable-drop packet encoding.
 *
 * The code encrypts the manifest with PBKDF2-SHA256 and AES-GCM; the bearer
 * separately authenticates the outer envelope. A link alone cannot open it.
 * `ospd1` is refused: its code was only a bypassable client-side check.
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
import {
  CODE_KDF,
  CODE_KDF_ITERATIONS,
  type CodeSealedManifest,
  openCodeManifest,
  sealCodeManifest,
} from "./portable-drop-code.js";
import {
  MAX_CODE_CIPHERTEXT_CHARS,
  MAX_PORTABLE_PACKET_CHARS,
} from "./portable-drop-limits.js";

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

const PACKET_PREFIX = "ospd2";
const NONCE_BYTES = 12;
const SALT_BYTES = 16;
const DIGEST_BYTES = 32;
const HKDF_INFO = "opensesame.portable-drop.transport.v2";
const TOKEN_DIGEST_INFO = "opensesame.portable-drop.token.v2";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type PortableBearer = {
  claimId: string;
  secret: Uint8Array;
  secretText: string;
};

export type DecodedPortableDrop = {
  claimId: string;
  sealedManifest: CodeSealedManifest;
  expiresAtMs: number;
  codeSalt: Uint8Array;
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

function decodeBytes(value: string, length?: number): Uint8Array {
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

function associatedData(
  claimId: string,
  tokenDigest: string,
  nonce: string,
): Uint8Array {
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
    v: 2,
    sealedManifest: await sealCodeManifest(input.manifest, input.userCode, {
      claimId: bearer.claimId,
      expiresAtMs: input.expiresAtMs,
      codeSalt,
    }),
    expiresAtMs: input.expiresAtMs,
    codeKdf: {
      algorithm: CODE_KDF,
      iterations: CODE_KDF_ITERATIONS,
      salt,
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
  const manifest = root.sealedManifest;
  const kdf = root.codeKdf;
  const expiresAtMs = root.expiresAtMs;
  if (
    root.v !== 2 ||
    !isNumber(expiresAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0 ||
    !isJsonObject(manifest) ||
    !isJsonObject(kdf)
  ) {
    throw tampered();
  }
  return {
    claimId,
    expiresAtMs,
    ...readCodeMetadata(manifest, kdf),
  };
}

function readCodeMetadata(
  sealed: BoundaryObject,
  code: BoundaryObject,
): Pick<DecodedPortableDrop, "sealedManifest" | "codeSalt" | "codeKdf"> {
  const salt = code.salt;
  if (
    code.algorithm !== CODE_KDF ||
    code.iterations !== CODE_KDF_ITERATIONS ||
    !isString(salt) ||
    !isString(sealed.nonce) ||
    !isString(sealed.ciphertext) ||
    sealed.ciphertext.length > MAX_CODE_CIPHERTEXT_CHARS
  ) {
    throw tampered();
  }
  try {
    decodeBytes(sealed.nonce, NONCE_BYTES);
    if (decodeBytes(sealed.ciphertext).length < 16) throw tampered();
    return {
      sealedManifest: { nonce: sealed.nonce, ciphertext: sealed.ciphertext },
      codeSalt: decodeBytes(salt, SALT_BYTES),
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
  if (pkt.length > MAX_PORTABLE_PACKET_CHARS) throw tampered();
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

export async function openPortableDropManifest(
  decoded: DecodedPortableDrop,
  userCode: string,
): Promise<JsonObject | null> {
  return openCodeManifest(decoded.sealedManifest, userCode, decoded);
}
