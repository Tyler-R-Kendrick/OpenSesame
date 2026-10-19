import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { type CBORType, decodeCBOR, encodeCBOR } from "@levischuck/tiny-cbor";
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import {
  type BitwardenCborMap,
  bitwardenCborBytes,
  bitwardenCborMap,
} from "./bitwarden-native-cose.js";
import { nativeObject, nativeText } from "./bitwarden-native-item.js";

export const NATIVE_USER = "0be8e291-63ac-4ae3-a9d6-6308474ceeca";
export const NATIVE_EMAIL = "owned-person@example.test";
export const NATIVE_PASSWORD = " owned native HTTP master 🔐 ";
export const NATIVE_LIMITS = {
  maxPbkdf2Iterations: 5000,
  maxArgon2Iterations: 2,
  maxArgon2MemoryMiB: 16,
  maxArgon2Parallelism: 1,
};
const material = Uint8Array.from({ length: 64 }, (_, i) => i + 17);
const kid = new Uint8Array(16).fill(7);
const decode = (bytes: Uint8Array) => decodeCBOR(new Uint8Array(bytes));
const map = (entries: [string | number, CBORType][]) => new Map(entries);
function pad(bytes: Uint8Array, minimum: number): Uint8Array {
  const count = Math.max(1, minimum - bytes.length);
  return new Uint8Array(Buffer.concat([bytes, Buffer.alloc(count, count)]));
}
function wrap(bytes: Uint8Array, key: Uint8Array): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.slice(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = createHmac("sha256", key.slice(32))
    .update(iv)
    .update(ciphertext)
    .digest();
  return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${tag.toString("base64")}`;
}
function unwrap(text: string, key: Uint8Array): Uint8Array {
  const [iv, ciphertext, tag] = text
    .slice(2)
    .split("|")
    .map((part) => Buffer.from(part, "base64"));
  assert(
    timingSafeEqual(
      tag,
      createHmac("sha256", key.slice(32))
        .update(iv)
        .update(ciphertext)
        .digest(),
    ),
  );
  const cipher = createDecipheriv("aes-256-cbc", key.slice(0, 32), iv);
  return new Uint8Array(
    Buffer.concat([cipher.update(ciphertext), cipher.final()]),
  );
}
function block(key: Uint8Array, bytes: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-256-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
function xaesKey(key: Uint8Array, nonce: Uint8Array): Buffer {
  const value = BigInt(`0x${block(key, new Uint8Array(16)).toString("hex")}`);
  const mask =
    ((value << 1n) & ((1n << 128n) - 1n)) ^ (value >> 127n ? 0x87n : 0n);
  return Buffer.concat(
    [1, 2].map((counter) => {
      const input = Buffer.concat([
        Buffer.from([0, counter, 0x58, 0]),
        nonce.slice(0, 12),
      ]);
      const mixed = BigInt(`0x${input.toString("hex")}`) ^ mask;
      return block(
        key,
        Buffer.from(mixed.toString(16).padStart(32, "0"), "hex"),
      );
    }),
  );
}
function gcmOpen(value: CBORType, key: Uint8Array, xaes: boolean): Uint8Array {
  assert(Array.isArray(value));
  const protectedBytes = bitwardenCborBytes(value[0]);
  const nonce = bitwardenCborBytes(bitwardenCborMap(value[1]).get(5));
  const ciphertext = bitwardenCborBytes(value[2]);
  const cipher = createDecipheriv(
    "aes-256-gcm",
    xaes ? xaesKey(key, nonce) : key,
    xaes ? nonce.slice(12) : nonce,
  );
  cipher.setAAD(encodeCBOR(["Encrypt0", protectedBytes, new Uint8Array()]));
  cipher.setAuthTag(ciphertext.slice(-16));
  return new Uint8Array(
    Buffer.concat([cipher.update(ciphertext.slice(0, -16)), cipher.final()]),
  );
}
function itemKey(value: BoundaryValue): Uint8Array {
  const encoded = nativeText(value);
  if (encoded.startsWith("2.")) return unwrap(encoded, material);
  assert(encoded.startsWith("7."));
  const envelope = decode(
    new Uint8Array(Buffer.from(encoded.slice(2), "base64")),
  );
  const bytes = gcmOpen(envelope, material.slice(0, 32), true);
  assert(Array.isArray(envelope));
  const header = bitwardenCborMap(decode(bitwardenCborBytes(envelope[0])));
  if (header.get(3) === "application/x.bitwarden.legacy-key") return bytes;
  const key = bitwardenCborMap(
    decode(bytes.slice(0, -bytes[bytes.length - 1])),
  );
  return bitwardenCborBytes(key.get(-1));
}
export function nativeProviderPlaintext(wire: JsonObject): BitwardenCborMap {
  const key = wire.key ? itemKey(wire.key) : material;
  if (!wire.data) {
    const open = (value: BoundaryValue) =>
      value === null || value === undefined
        ? ""
        : new TextDecoder("utf8", { fatal: true }).decode(
            unwrap(nativeText(value), key),
          );
    const login = wire.type === 1 ? nativeObject(wire.login) : {};
    return map([
      ["name", open(wire.name)],
      ["notes", open(wire.notes)],
      ["password", open(login.password)],
      ["username", open(login.username)],
    ]);
  }
  const container = nativeObject(JSON.parse(nativeText(wire.data)));
  const padded = unwrap(nativeText(container.wrapped_cek), key);
  const cek = bitwardenCborMap(
    decode(padded.slice(0, -padded[padded.length - 1])),
  );
  const bytes = gcmOpen(
    decode(
      new Uint8Array(Buffer.from(nativeText(container.envelope), "base64")),
    ),
    bitwardenCborBytes(cek.get(-1)),
    false,
  );
  return bitwardenCborMap(
    bitwardenCborMap(decode(bytes.slice(0, -bytes[bytes.length - 1]))).get(
      "content",
    ),
  );
}
export function nativeFixtureUnlock(modern: boolean) {
  const raw = modern
    ? pad(
        encodeCBOR(
          map([
            [1, 4],
            [2, kid],
            [3, -70010],
            [4, [3, 4, 5, 6]],
            [-1, material.slice(0, 32)],
          ]),
        ),
        65,
      )
    : material;
  const master = pbkdf2Sync(NATIVE_PASSWORD, NATIVE_EMAIL, 5000, 32, "sha256");
  const stretched = Buffer.concat(
    ["enc", "mac"].map((info) =>
      createHmac("sha256", master)
        .update(Buffer.from(`${info}\x01`))
        .digest(),
    ),
  );
  const wrapped = wrap(raw, stretched);
  const unlock = {
    salt: NATIVE_EMAIL,
    kdf: { kdfType: 0, iterations: 5000 },
    masterKeyWrappedUserKey: wrapped,
  };
  return unlock;
}

export const NATIVE_KEY_ID = Buffer.from(kid).toString("hex");
