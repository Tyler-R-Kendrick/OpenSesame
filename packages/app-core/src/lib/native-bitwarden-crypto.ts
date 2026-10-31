/**
 * Bitwarden's client-side cryptography, using Web Crypto and the shared
 * Argon2id implementation (ADR 0218): the `EncString` envelope (AES-256-CBC with an
 * HMAC-SHA256 over the IV and ciphertext, verified before anything is
 * decrypted), HKDF-Expand key stretching, the master-key derivations
 * (PBKDF2-SHA256 and Argon2id) and the Secrets Manager access-token key.
 * Pure functions of bytes: no network, no storage, nothing logged.
 */
import { argon2id } from "hash-wasm";

const encoder = new TextEncoder();

export type BitwardenKey = { enc: Uint8Array; mac: Uint8Array };

export class BitwardenCryptoError extends Error {
  constructor() {
    super("Bitwarden data could not be decrypted");
    this.name = "BitwardenCryptoError";
  }
}

const fail = (): never => {
  throw new BitwardenCryptoError();
};

/** A fresh ArrayBuffer-backed copy: Web Crypto takes no view over a shared buffer. */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array(bytes);

export function base64Bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) return fail();
  const normal = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return fail();
  }
}

export function bytesBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function hmacKey(key: Uint8Array, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    own(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), own(data)),
  );
}

/** HKDF-Expand (RFC 5869) with HMAC-SHA256, for up to 255 blocks. */
export async function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (length < 1 || length > 255 * 32) return fail();
  const out = new Uint8Array(Math.ceil(length / 32) * 32);
  let previous = new Uint8Array(0);
  for (let block = 1; block * 32 <= out.length; block++) {
    const input = new Uint8Array(previous.length + info.length + 1);
    input.set(previous, 0);
    input.set(info, previous.length);
    input[input.length - 1] = block;
    previous = await hmacSha256(prk, input);
    out.set(previous, (block - 1) * 32);
  }
  return out.slice(0, length);
}

const split = (bytes: Uint8Array): BitwardenKey => {
  if (bytes.length !== 64) return fail();
  return { enc: bytes.slice(0, 32), mac: bytes.slice(32) };
};

/** A 64-byte symmetric key as Bitwarden stores it: 32 bytes to encrypt with, 32 to authenticate with. */
export function symmetricKey(bytes: Uint8Array): BitwardenKey {
  return split(bytes);
}

/** A 32-byte master key stretched into an encryption key and a MAC key. */
export async function stretchMasterKey(
  master: Uint8Array,
): Promise<BitwardenKey> {
  if (master.length !== 32) return fail();
  return {
    enc: await hkdfExpand(master, encoder.encode("enc"), 32),
    mac: await hkdfExpand(master, encoder.encode("mac"), 32),
  };
}

/** The key a Secrets Manager access token's own 16 bytes stand for. */
export async function accessTokenKey(
  secret: Uint8Array,
): Promise<BitwardenKey> {
  if (secret.length !== 16) return fail();
  const prk = await hmacSha256(encoder.encode("bitwarden-accesstoken"), secret);
  return split(await hkdfExpand(prk, encoder.encode("sm-access-token"), 64));
}

export type MasterKdf =
  | { kind: "pbkdf2"; iterations: number }
  | {
      kind: "argon2id";
      iterations: number;
      memoryMiB: number;
      parallelism: number;
    };

const BOUNDS = {
  pbkdf2: { min: 5_000, max: 2_000_000 },
  argon2: { iterations: [2, 10], memory: [16, 1024], parallelism: [1, 16] },
} as const;

/** Parameters a server states are used only inside the bounds an honest account has. */
export function boundedKdf(kdf: MasterKdf): MasterKdf {
  const within = (value: number, [low, high]: readonly [number, number]) =>
    Number.isInteger(value) && value >= low && value <= high;
  if (kdf.kind === "pbkdf2") {
    if (!within(kdf.iterations, [BOUNDS.pbkdf2.min, BOUNDS.pbkdf2.max]))
      return fail();
    return kdf;
  }
  if (
    !within(kdf.iterations, BOUNDS.argon2.iterations) ||
    !within(kdf.memoryMiB, BOUNDS.argon2.memory) ||
    !within(kdf.parallelism, BOUNDS.argon2.parallelism)
  )
    return fail();
  return kdf;
}

/** The 32-byte master key from a master password and the account's email, by the account's KDF. */
export async function masterKey(
  password: string,
  email: string,
  kdf: MasterKdf,
): Promise<Uint8Array> {
  const salt = encoder.encode(email.trim().toLowerCase());
  const secret = encoder.encode(password);
  const checked = boundedKdf(kdf);
  if (checked.kind === "pbkdf2") {
    const base = await crypto.subtle.importKey(
      "raw",
      own(secret),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: own(salt),
          iterations: checked.iterations,
        },
        base,
        256,
      ),
    );
  }
  // Argon2id's salt is the SHA-256 of the email.
  const hashedSalt = new Uint8Array(
    await crypto.subtle.digest("SHA-256", own(salt)),
  );
  return argon2id({
    password: secret,
    salt: hashedSalt,
    iterations: checked.iterations,
    memorySize: checked.memoryMiB * 1024,
    parallelism: checked.parallelism,
    hashLength: 32,
    outputType: "binary",
  });
}

/** The password hash an account logs in with: one more PBKDF2 round over the master key. */
export async function loginHash(
  master: Uint8Array,
  password: string,
): Promise<string> {
  const base = await crypto.subtle.importKey(
    "raw",
    own(master),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return bytesBase64(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: own(encoder.encode(password)),
          iterations: 1,
        },
        base,
        256,
      ),
    ),
  );
}

type Parsed = { iv: Uint8Array; data: Uint8Array; mac: Uint8Array };

/** `2.iv|ciphertext|mac`, each part base64: the only envelope read here. */
function parseEncString(value: string): Parsed {
  const match = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(value);
  if (!match) return fail();
  const [, iv, data, mac] = match;
  const parsed = {
    iv: base64Bytes(iv ?? ""),
    data: base64Bytes(data ?? ""),
    mac: base64Bytes(mac ?? ""),
  };
  if (parsed.iv.length !== 16 || parsed.mac.length !== 32) return fail();
  if (parsed.data.length === 0 || parsed.data.length % 16 !== 0) return fail();
  return parsed;
}

/** Decrypt an EncString, authenticating it first: a tampered or wrong-key envelope yields nothing. */
export async function decryptBytes(
  value: string,
  key: BitwardenKey,
): Promise<Uint8Array> {
  const { iv, data, mac } = parseEncString(value);
  const signed = new Uint8Array(iv.length + data.length);
  signed.set(iv, 0);
  signed.set(data, iv.length);
  const authentic = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(key.mac, "verify"),
    own(mac),
    own(signed),
  );
  if (!authentic) return fail();
  try {
    const aes = await crypto.subtle.importKey(
      "raw",
      own(key.enc),
      "AES-CBC",
      false,
      ["decrypt"],
    );
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-CBC", iv: own(iv) },
        aes,
        own(data),
      ),
    );
  } catch {
    return fail();
  }
}

export async function decryptText(
  value: string,
  key: BitwardenKey,
): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await decryptBytes(value, key),
    );
  } catch {
    return fail();
  }
}

/** Encrypt to an EncString. Used to prove the envelope round-trips; Bitwarden's own clients write it the same way. */
export async function encryptBytes(
  data: Uint8Array,
  key: BitwardenKey,
  iv: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): Promise<string> {
  const aes = await crypto.subtle.importKey(
    "raw",
    own(key.enc),
    "AES-CBC",
    false,
    ["encrypt"],
  );
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: own(iv) },
      aes,
      own(data),
    ),
  );
  const signed = new Uint8Array(iv.length + body.length);
  signed.set(iv, 0);
  signed.set(body, iv.length);
  const mac = await hmacSha256(key.mac, signed);
  return `2.${bytesBase64(iv)}|${bytesBase64(body)}|${bytesBase64(mac)}`;
}
