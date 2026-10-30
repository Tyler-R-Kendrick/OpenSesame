import type { CBORType } from "@levischuck/tiny-cbor";
import { gcm } from "@noble/ciphers/aes.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core/bytes.js";
import { z } from "zod";
import {
  BITWARDEN_CBOR_BYTES,
  type BitwardenCborMap,
  type BitwardenNativeKey,
  bitwardenCborBytes,
  bitwardenCborMap,
  decodeBitwardenCbor,
  decodeBitwardenKey,
  encodeBitwardenCbor,
  encodeBitwardenKey,
  padBitwardenBytes,
  unpadBitwardenBytes,
} from "./bitwarden-native-cose.js";
import {
  openBitwardenEncString,
  sealBitwardenEncString,
} from "./bitwarden-native-envelope.js";
import {
  openBitwardenXaes,
  sealBitwardenXaes,
} from "./bitwarden-native-xaes.js";

const MAX_BLOB = 1024 * 1024;
const LEGACY_KEY = "application/x.bitwarden.legacy-key";
const PADDED_CBOR = "application/x.bitwarden.cbor-padded";
const bad = () => new Error("Bitwarden protected data could not be opened.");
const containerSchema = z
  .object({
    format_version: z.literal(1),
    wrapped_cek: z.string().max(16384),
    envelope: z.string().max(2 * MAX_BLOB),
  })
  .strict();

function base64(text: string): Uint8Array {
  if (
    !z
      .string()
      .min(4)
      .max(Math.ceil(BITWARDEN_CBOR_BYTES / 3) * 4)
      .safeParse(text).success ||
    text.length % 4
  )
    throw bad();
  const bytes = b64ToBytes(text);
  if (bytes.length > BITWARDEN_CBOR_BYTES || bytesToB64(bytes) !== text)
    throw bad();
  return bytes;
}

function checkOperation(key: BitwardenNativeKey, operation: number): void {
  if (
    !key.operations.includes(operation) ||
    key.id.length !== 16 ||
    key.material.length !== (key.algorithm === -70011 ? 64 : 32)
  )
    throw bad();
}

function crypt(
  body: Uint8Array,
  key: BitwardenNativeKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  opening: boolean,
): Uint8Array {
  if (key.algorithm === -70010)
    return opening
      ? openBitwardenXaes(body, key.material, nonce, aad)
      : sealBitwardenXaes(body, key.material, nonce, aad);
  if (key.algorithm !== 3 || nonce.length !== 12) throw bad();
  const material = key.material.slice();
  try {
    const cipher = gcm(material, nonce, aad);
    return opening ? cipher.decrypt(body) : cipher.encrypt(body);
  } finally {
    material.fill(0);
  }
}

function protectedContext(
  header: BitwardenCborMap,
  key: BitwardenNativeKey,
  blob: boolean,
) {
  const allowed = blob ? [1, 2, 3, 4, -80002, -80001] : [1, 2, 3, 4];
  if (
    [...header.keys()].some(
      (label) => !allowed.includes(z.number().parse(label)),
    ) ||
    header.get(1) !== key.algorithm ||
    !equalBytes(bitwardenCborBytes(header.get(4)), key.id)
  )
    throw bad();
  const contentType = z
    .union([z.literal(101), z.literal(LEGACY_KEY), z.literal(PADDED_CBOR)])
    .parse(header.get(3));
  if (
    blob
      ? contentType !== PADDED_CBOR ||
        header.get(-80002) !== 2 ||
        header.get(-80001) !== 1
      : contentType === PADDED_CBOR
  )
    throw bad();
  checkCritical(header, allowed);
  return contentType;
}

function checkCritical(header: BitwardenCborMap, allowed: number[]): void {
  if (header.has(2)) {
    const critical = z
      .array(z.number().int())
      .min(1)
      .max(6)
      .parse(header.get(2));
    if (
      new Set(critical).size !== critical.length ||
      critical.some(
        (label) =>
          label === 2 || !allowed.includes(label) || !header.has(label),
      )
    )
      throw bad();
  }
}

function openEnvelope(
  encoded: Uint8Array,
  key: BitwardenNativeKey,
  blob: boolean,
) {
  checkOperation(key, blob ? 4 : 6);
  if ((blob && key.algorithm !== 3) || (!blob && key.algorithm !== -70010))
    throw bad();
  const value = decodeBitwardenCbor(encoded, BITWARDEN_CBOR_BYTES);
  if (!Array.isArray(value) || value.length !== 3) throw bad();
  const protectedBytes = bitwardenCborBytes(value[0]);
  const header = bitwardenCborMap(decodeBitwardenCbor(protectedBytes, 1024));
  const unprotected = bitwardenCborMap(value[1]);
  if (unprotected.size !== 1 || !unprotected.has(5)) throw bad();
  const contentType = protectedContext(header, key, blob);
  const nonce = bitwardenCborBytes(unprotected.get(5));
  if (nonce.length !== (blob ? 12 : 24)) throw bad();
  const aad = encodeBitwardenCbor(
    ["Encrypt0", protectedBytes, new Uint8Array()],
    2048,
  );
  return {
    plaintext: crypt(bitwardenCborBytes(value[2]), key, nonce, aad, true),
    contentType,
  };
}

function sealEnvelope(
  plaintext: Uint8Array,
  key: BitwardenNativeKey,
  blob: boolean,
): Uint8Array {
  checkOperation(key, blob ? 3 : 5);
  if ((blob && key.algorithm !== 3) || (!blob && key.algorithm !== -70010))
    throw bad();
  const header: BitwardenCborMap = new Map<string | number, CBORType>([
    [1, key.algorithm],
    [3, blob ? PADDED_CBOR : LEGACY_KEY],
    [4, key.id],
  ]);
  if (blob) {
    header.set(-80002, 2);
    header.set(-80001, 1);
  }
  const protectedBytes = encodeBitwardenCbor(header, 1024);
  const nonce = crypto.getRandomValues(new Uint8Array(blob ? 12 : 24));
  const aad = encodeBitwardenCbor(
    ["Encrypt0", protectedBytes, new Uint8Array()],
    2048,
  );
  const ciphertext = crypt(plaintext, key, nonce, aad, false);
  return encodeBitwardenCbor(
    [protectedBytes, new Map([[5, nonce]]), ciphertext],
    BITWARDEN_CBOR_BYTES,
  );
}

function unwrapBytes(text: string, wrapping: BitwardenNativeKey) {
  if (!z.string().max(16384).safeParse(text).success) throw bad();
  if (text.startsWith("2.") && wrapping.algorithm === -70011)
    return {
      plaintext: openBitwardenEncString(text, wrapping.material),
      contentType: LEGACY_KEY,
    };
  if (text.startsWith("7."))
    return openEnvelope(base64(text.slice(2)), wrapping, false);
  throw bad();
}

function validWrappedKey(
  key: BitwardenNativeKey,
  purpose: "item" | "cek",
): boolean {
  if (purpose === "cek")
    return (
      key.algorithm === 3 &&
      key.operations.length === 1 &&
      key.operations[0] === 4
    );
  return (
    (key.algorithm === -70011 || key.algorithm === -70010) &&
    key.operations.includes(6)
  );
}

/** Item keys may be legacy64 or XAES; persisted single-use blob CEKs are GCM/decrypt-only. */
export function openBitwardenWrappedKey(
  text: string,
  wrapping: BitwardenNativeKey,
  purpose: "item" | "cek",
): BitwardenNativeKey {
  let plaintext: Uint8Array | undefined;
  let converted: Uint8Array | undefined;
  try {
    checkOperation(wrapping, 6);
    const opened = unwrapBytes(text, wrapping);
    plaintext = opened.plaintext;
    if (opened.contentType === 101)
      converted = padBitwardenBytes(plaintext, 65);
    const key = decodeBitwardenKey(converted ?? plaintext);
    const valid = validWrappedKey(key, purpose);
    if (!valid) {
      key.material.fill(0);
      throw bad();
    }
    return key;
  } catch {
    throw bad();
  } finally {
    plaintext?.fill(0);
    converted?.fill(0);
  }
}

export function sealBitwardenWrappedKey(
  key: BitwardenNativeKey,
  wrapping: BitwardenNativeKey,
): string {
  const encoded = encodeBitwardenKey(key);
  try {
    checkOperation(wrapping, 5);
    if (wrapping.algorithm === -70011)
      return sealBitwardenEncString(encoded, wrapping.material);
    return `7.${bytesToB64(sealEnvelope(encoded, wrapping, false))}`;
  } finally {
    encoded.fill(0);
  }
}

function validateModel(value: CBORType): BitwardenCborMap {
  const model = bitwardenCborMap(value);
  const content = bitwardenCborMap(model.get("content"));
  if (model.get("version") !== "1") throw bad();
  z.string().max(4096).parse(content.get("name"));
  z.string().max(MAX_BLOB).nullable().parse(content.get("notes"));
  z.enum([
    "login",
    "secureNote",
    "card",
    "identity",
    "sshKey",
    "bankAccount",
    "passport",
    "driversLicense",
  ]).parse(bitwardenCborMap(content.get("typeData")).get("type"));
  return model; // Preserve all unknown supported CBOR members through edits.
}

/** No legacy-field fallback: authenticate CEK, namespace, format, padding and model. */
export function openBitwardenBlob(
  data: string,
  itemKey: BitwardenNativeKey,
): BitwardenCborMap {
  let cek: BitwardenNativeKey | undefined;
  let padded: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    if (
      !z
        .string()
        .max(2 * MAX_BLOB + 16384)
        .safeParse(data).success
    )
      throw bad();
    const container = containerSchema.parse(JSON.parse(data));
    cek = openBitwardenWrappedKey(container.wrapped_cek, itemKey, "cek");
    padded = openEnvelope(base64(container.envelope), cek, true).plaintext;
    plaintext = unpadBitwardenBytes(padded, 64);
    return validateModel(decodeBitwardenCbor(plaintext, MAX_BLOB));
  } catch {
    throw bad();
  } finally {
    cek?.material.fill(0);
    padded?.fill(0);
    plaintext?.fill(0);
  }
}

/** Rewrites preserve the versioned model/item key; every write uses a fresh single-use CEK. */
export function sealBitwardenBlob(
  model: BitwardenCborMap,
  itemKey: BitwardenNativeKey,
): string {
  let serialized: Uint8Array | undefined;
  let padded: Uint8Array | undefined;
  const cek: BitwardenNativeKey = {
    algorithm: 3,
    id: crypto.getRandomValues(new Uint8Array(16)),
    material: crypto.getRandomValues(new Uint8Array(32)),
    operations: [3, 4],
  };
  try {
    validateModel(model);
    serialized = encodeBitwardenCbor(model, MAX_BLOB);
    padded = padBitwardenBytes(serialized, 64);
    const envelope = bytesToB64(sealEnvelope(padded, cek, true));
    cek.operations = [4]; // Persist only decrypt permission after its single use.
    const wrapped_cek = sealBitwardenWrappedKey(cek, itemKey);
    return JSON.stringify({ format_version: 1, wrapped_cek, envelope });
  } catch {
    throw new Error("Bitwarden protected data could not be sealed.");
  } finally {
    cek.material.fill(0);
    serialized?.fill(0);
    padded?.fill(0);
  }
}
