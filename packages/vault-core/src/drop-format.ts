/**
 * The secret-drop format (ADR 0062, docs/design/secret-drop.md): a payload
 * sealed under a fresh AES-GCM-256 drop key whose raw bytes ride the link's
 * `#key=` fragment. Text is one sealed blob; a file is 1 MiB plaintext
 * chunks sealed on their own, each with a SHA-256 digest, and one for the
 * whole payload (the ADR 0054 attachment layout). v1 caps total ciphertext
 * at 1 MiB. Both sides share it: the vault seals, Pages' `/claim` opens.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  b64ToBytes,
  b64urlToBytes,
  bytesToB64,
  bytesToB64url,
} from "./bytes.js";
import { randomBytes } from "./crypto.js";

/** Plaintext bytes per chunk — the ADR 0054 chunk size. */
export const DROP_CHUNK_BYTES = 1_048_576;
/** Hard ceiling on one drop's total sealed bytes (the claim manifest is JSON). */
export const MAX_DROP_CIPHERTEXT_BYTES = 1_048_576;

export const DROP_MANIFEST_KIND = "secret-drop";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type DropTextPayload = {
  kind: "text";
  name: string;
  text: string;
};

export type DropFilePayload = {
  kind: "file";
  name: string;
  contentType: string;
  bytes: Uint8Array;
};

export type DropPayload = DropTextPayload | DropFilePayload;

export type DropChunk = {
  /** AES-GCM iv for this chunk, base64. */
  nonce: string;
  /** Sealed chunk bytes, base64. */
  ciphertext: string;
  /** SHA-256 of the plaintext chunk, base64. */
  digest: string;
};

export type DropManifest = {
  kind: "secret-drop";
  name: string;
  contentType: string;
  /** Whole-blob ciphertext (text drops). Empty when the payload is chunked. */
  ciphertext: string;
  /** AES-GCM iv for the whole-blob ciphertext. Empty for chunked payloads. */
  nonce: string;
  /** Chunked file payload: 1 MiB plaintext chunks, each sealed on its own. */
  chunks?: DropChunk[];
  /** SHA-256 of the whole plaintext payload, base64 (chunked payloads). */
  digest?: string;
};

export type DropFormatErrorCode =
  | "payload_too_large"
  | "invalid_manifest"
  | "invalid_key"
  | "tampered";

/** A drop that cannot be sealed or opened; each side maps it to its own error. */
export class DropFormatError extends Error {
  constructor(
    readonly code: DropFormatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DropFormatError";
  }
}

async function importDropKey(fragmentKey: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64urlToBytes(fragmentKey);
  } catch {
    throw new DropFormatError(
      "invalid_key",
      "This drop link's decryption key is not readable. Ask for a fresh link.",
    );
  }
  if (raw.length !== KEY_BYTES) {
    throw new DropFormatError(
      "invalid_key",
      "This drop link is missing its decryption key. Ask for a fresh link.",
    );
  }
  return crypto.subtle.importKey("raw", overlapCast(raw), "AES-GCM", false, [
    "decrypt",
  ]);
}

type SealedPart = { nonce: string; ciphertext: string };

async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<SealedPart> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: overlapCast(iv) },
    key,
    overlapCast(plaintext),
  );
  return {
    nonce: bytesToB64(iv),
    ciphertext: bytesToB64(new Uint8Array(ct)),
  };
}

async function open(
  key: CryptoKey,
  nonce: string,
  ciphertext: string,
): Promise<Uint8Array> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: overlapCast(b64ToBytes(nonce)) },
      key,
      overlapCast(b64ToBytes(ciphertext)),
    );
    return new Uint8Array(plain);
  } catch {
    throw new DropFormatError(
      "tampered",
      "This drop could not be opened — the ciphertext or the key does not match what was sealed.",
    );
  }
}

async function sha256B64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", overlapCast(bytes));
  return bytesToB64(new Uint8Array(digest));
}

function sealedSize(ciphertextB64: string): number {
  return b64ToBytes(ciphertextB64).length;
}

function assertWithinCap(totalCiphertext: number): void {
  if (totalCiphertext > MAX_DROP_CIPHERTEXT_BYTES) {
    throw new DropFormatError(
      "payload_too_large",
      "Drops are limited to 1 MiB of encrypted payload. Shorten the text or share a smaller file.",
    );
  }
}

export type SealedDrop = {
  manifest: DropManifest;
  /** Base64url raw drop key for the link's `#key=` fragment — never a request body. */
  fragmentKey: string;
};

/**
 * Seal a payload under a fresh drop key. The returned `fragmentKey` is the
 * base64url raw key for the link's `#key=` fragment — it must never appear
 * in a request body.
 */
export async function sealDrop(payload: DropPayload): Promise<SealedDrop> {
  const rawKey = randomBytes(KEY_BYTES);
  const key = await crypto.subtle.importKey(
    "raw",
    overlapCast(rawKey),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  try {
    if (payload.kind === "text") {
      const sealed = await seal(key, new TextEncoder().encode(payload.text));
      assertWithinCap(sealedSize(sealed.ciphertext));
      return {
        manifest: {
          kind: DROP_MANIFEST_KIND,
          name: payload.name,
          contentType: "text/plain",
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
        },
        fragmentKey: bytesToB64url(rawKey),
      };
    }

    const chunks: DropChunk[] = [];
    let total = 0;
    for (
      let offset = 0;
      offset < payload.bytes.length;
      offset += DROP_CHUNK_BYTES
    ) {
      const chunk = payload.bytes.slice(offset, offset + DROP_CHUNK_BYTES);
      const sealed = await seal(key, chunk);
      total += sealedSize(sealed.ciphertext);
      assertWithinCap(total);
      chunks.push({
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        digest: await sha256B64(chunk),
      });
    }
    return {
      manifest: {
        kind: DROP_MANIFEST_KIND,
        name: payload.name,
        contentType: payload.contentType || "application/octet-stream",
        ciphertext: "",
        nonce: "",
        chunks,
        digest: await sha256B64(payload.bytes),
      },
      fragmentKey: bytesToB64url(rawKey),
    };
  } finally {
    rawKey.fill(0);
  }
}

function guardChunk(value: BoundaryValue): DropChunk {
  if (!isJsonObject(value)) throw invalidManifest();
  const { nonce, ciphertext, digest } = value;
  if (!isString(nonce) || !isString(ciphertext) || !isString(digest)) {
    throw invalidManifest();
  }
  return { nonce, ciphertext, digest };
}

function invalidManifest(): DropFormatError {
  return new DropFormatError(
    "invalid_manifest",
    "This drop's payload is not in the shape a drop should have. Ask for a fresh link.",
  );
}

/** Guard the server-returned manifest before anything is decoded from it. */
export function guardManifest(value: BoundaryValue): DropManifest {
  if (!isJsonObject(value)) throw invalidManifest();
  if (value.kind !== DROP_MANIFEST_KIND) throw invalidManifest();
  const { name, contentType, ciphertext, nonce, chunks, digest } = value;
  if (
    !isString(name) ||
    !isString(contentType) ||
    !isString(ciphertext) ||
    !isString(nonce)
  ) {
    throw invalidManifest();
  }
  const manifest: DropManifest = {
    kind: DROP_MANIFEST_KIND,
    name,
    contentType,
    ciphertext,
    nonce,
  };
  if (chunks !== undefined) {
    if (!Array.isArray(chunks) || chunks.length === 0) throw invalidManifest();
    manifest.chunks = chunks.map(guardChunk);
    if (!isString(digest)) throw invalidManifest();
    manifest.digest = digest;
  }
  return manifest;
}

async function assertDigest(
  bytes: Uint8Array,
  expected: string,
  what: string,
): Promise<void> {
  if ((await sha256B64(bytes)) !== expected) {
    throw new DropFormatError(
      "tampered",
      `This drop failed its ${what} digest check — the payload was altered after sealing.`,
    );
  }
}

/** Decrypt and digest-verify a presented drop manifest. */
export async function openDrop(
  value: BoundaryValue,
  fragmentKey: string,
): Promise<DropPayload> {
  const manifest = guardManifest(value);
  const key = await importDropKey(fragmentKey);

  if (manifest.chunks) {
    const parts: Uint8Array[] = [];
    let length = 0;
    for (const chunk of manifest.chunks) {
      const plain = await open(key, chunk.nonce, chunk.ciphertext);
      await assertDigest(plain, chunk.digest, "chunk");
      parts.push(plain);
      length += plain.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    // guardManifest requires the whole digest whenever chunks are present.
    await assertDigest(bytes, manifest.digest ?? "", "whole-payload");
    return {
      kind: "file",
      name: manifest.name,
      contentType: manifest.contentType,
      bytes,
    };
  }

  const plain = await open(key, manifest.nonce, manifest.ciphertext);
  return {
    kind: "text",
    name: manifest.name,
    text: new TextDecoder().decode(plain),
  };
}
