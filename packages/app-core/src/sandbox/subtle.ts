/**
 * The slice of `crypto.subtle` the core uses, for an isolate that has no
 * WebCrypto (ADR 0133 §6): raw secret keys for PBKDF2, HKDF, HMAC and
 * AES-GCM; PBKDF2 and HKDF derivation; AES-GCM seal and open with additional
 * data; SHA-256 digests; HMAC-SHA-256 sign and verify. Backed by the audited
 * noble libraries. Anything else rejects with `NotSupportedError` rather than
 * guessing, and key bytes never appear on the key object: they live in a
 * private map, and `exportKey` hands them back only for an extractable key.
 */
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";

type Named = string | { name: string };
type Params = {
  name: string;
  hash?: Named;
  salt?: BufferSource;
  info?: BufferSource;
  iterations?: number;
  iv?: BufferSource;
  additionalData?: BufferSource;
  tagLength?: number;
  length?: number;
};

const SECRET_ALGORITHMS = new Set(["PBKDF2", "HKDF", "HMAC", "AES-GCM"]);

function failure(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const unsupported = (what: string) =>
  failure("NotSupportedError", `sandbox crypto does not support ${what}`);

function nameOf(algorithm: Named): string {
  return (typeof algorithm === "string" ? algorithm : algorithm.name)
    .toUpperCase()
    .replace(/^SHA(\d)/, "SHA-$1");
}

function bytes(data: BufferSource | undefined): Uint8Array {
  if (data === undefined) return new Uint8Array(0);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
  return new Uint8Array(data.slice(0));
}

function buffer(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}

/** The only hash this slice offers; anything else is refused, not substituted. */
function requireSha256(hash: Named | undefined): typeof sha256 {
  if (hash === undefined || nameOf(hash) !== "SHA-256")
    throw unsupported(`hash ${hash === undefined ? "(none)" : nameOf(hash)}`);
  return sha256;
}

export class SandboxCryptoKey {
  readonly type = "secret";
  constructor(
    readonly algorithm: Readonly<{ name: string; length?: number }>,
    readonly extractable: boolean,
    readonly usages: readonly string[],
  ) {}
}

const material = new WeakMap<SandboxCryptoKey, Uint8Array>();

function keyBytes(key: SandboxCryptoKey, usage: string): Uint8Array {
  const raw = material.get(key);
  if (!raw) throw failure("InvalidAccessError", "not a sandbox key");
  if (!key.usages.includes(usage))
    throw failure("InvalidAccessError", `key does not permit ${usage}`);
  return raw;
}

function importRaw(
  raw: Uint8Array,
  algorithm: Named,
  extractable: boolean,
  usages: readonly string[],
): SandboxCryptoKey {
  const name = nameOf(algorithm);
  if (!SECRET_ALGORITHMS.has(name)) throw unsupported(`key algorithm ${name}`);
  if (name === "AES-GCM" && ![16, 24, 32].includes(raw.length))
    throw failure("DataError", "AES-GCM keys are 128, 192 or 256 bits");
  const key = new SandboxCryptoKey(
    name === "AES-GCM" ? { name, length: raw.length * 8 } : { name },
    extractable,
    [...usages],
  );
  material.set(key, raw);
  return key;
}

async function deriveBitsNow(
  params: Params,
  key: SandboxCryptoKey,
  length: number,
): Promise<Uint8Array> {
  const secret = keyBytes(key, "deriveBits");
  const hash = requireSha256(params.hash);
  if (length % 8 !== 0) throw failure("OperationError", "length is not bytes");
  const name = nameOf(params.name);
  if (name === "PBKDF2") {
    if (!Number.isInteger(params.iterations) || (params.iterations ?? 0) < 1)
      throw failure("OperationError", "PBKDF2 needs an iteration count");
    return pbkdf2Async(hash, secret, bytes(params.salt), {
      c: params.iterations ?? 0,
      dkLen: length / 8,
    });
  }
  if (name === "HKDF")
    return hkdf(
      hash,
      secret,
      bytes(params.salt),
      bytes(params.info),
      length / 8,
    );
  throw unsupported(`derivation ${name}`);
}

function aesGcm(params: Params, key: SandboxCryptoKey, usage: string) {
  if (nameOf(params.name) !== "AES-GCM" || key.algorithm.name !== "AES-GCM")
    throw unsupported(`cipher ${nameOf(params.name)}`);
  if ((params.tagLength ?? 128) !== 128) throw unsupported("short GCM tags");
  const aad = params.additionalData;
  return gcm(
    keyBytes(key, usage),
    bytes(params.iv),
    aad === undefined ? undefined : bytes(aad),
  );
}

/** Derived-key usages ride on the base key's `deriveKey` permission. */
function withDeriveBits(key: SandboxCryptoKey): SandboxCryptoKey {
  keyBytes(key, "deriveKey");
  const usable = new SandboxCryptoKey(key.algorithm, false, ["deriveBits"]);
  material.set(usable, keyBytes(key, "deriveKey"));
  return usable;
}

export const sandboxSubtle = {
  async importKey(
    format: string,
    keyData: BufferSource,
    algorithm: Named,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<SandboxCryptoKey> {
    if (format !== "raw") throw unsupported(`key format ${format}`);
    return importRaw(bytes(keyData), algorithm, extractable, usages);
  },

  async exportKey(format: string, key: SandboxCryptoKey): Promise<ArrayBuffer> {
    if (format !== "raw") throw unsupported(`key format ${format}`);
    const raw = material.get(key);
    if (!raw || !key.extractable)
      throw failure("InvalidAccessError", "key is not extractable");
    return buffer(raw);
  },

  async deriveBits(
    params: Params,
    key: SandboxCryptoKey,
    length: number,
  ): Promise<ArrayBuffer> {
    return buffer(await deriveBitsNow(params, key, length));
  },

  async deriveKey(
    params: Params,
    key: SandboxCryptoKey,
    derived: Params,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<SandboxCryptoKey> {
    const length = derived.length ?? 256;
    const raw = await deriveBitsNow(params, withDeriveBits(key), length);
    return importRaw(raw, derived.name, extractable, usages);
  },

  async encrypt(
    params: Params,
    key: SandboxCryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer> {
    return buffer(aesGcm(params, key, "encrypt").encrypt(bytes(data)));
  },

  async decrypt(
    params: Params,
    key: SandboxCryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer> {
    const cipher = aesGcm(params, key, "decrypt");
    try {
      return buffer(cipher.decrypt(bytes(data)));
    } catch {
      throw failure("OperationError", "the data could not be decrypted");
    }
  },

  async digest(algorithm: Named, data: BufferSource): Promise<ArrayBuffer> {
    return buffer(requireSha256(algorithm)(bytes(data)));
  },

  async sign(
    algorithm: Named,
    key: SandboxCryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer> {
    if (nameOf(algorithm) !== "HMAC") throw unsupported(nameOf(algorithm));
    return buffer(hmac(sha256, keyBytes(key, "sign"), bytes(data)));
  },

  async verify(
    algorithm: Named,
    key: SandboxCryptoKey,
    signature: BufferSource,
    data: BufferSource,
  ): Promise<boolean> {
    if (nameOf(algorithm) !== "HMAC") throw unsupported(nameOf(algorithm));
    const expected = hmac(sha256, keyBytes(key, "verify"), bytes(data));
    const given = bytes(signature);
    let diff = expected.length ^ given.length;
    for (let index = 0; index < expected.length; index += 1)
      diff |= (expected[index] ?? 0) ^ (given[index] ?? 0);
    return diff === 0;
  },
};
