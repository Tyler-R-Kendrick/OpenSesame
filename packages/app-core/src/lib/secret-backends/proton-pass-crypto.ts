import { ownBytes } from "@opensesame/os-domain";
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core/bytes.js";
import { gcmOpen, gcmSeal } from "@opensesame/vault-core/gcm.js";
import { PROTON_ITEM_MAX_BYTES } from "./proton-pass-wire.js";

export type ProtonCryptoOwner = Readonly<{
  signal: AbortSignal;
  assertCurrent(): void;
}>;
export type ProtonEncryptionTag =
  | "sharekey"
  | "itemkey"
  | "itemcontent"
  | "vaultcontent"
  | "folderkey"
  | "foldercontent";

const TAGS = new Set([
  "sharekey",
  "itemkey",
  "itemcontent",
  "vaultcontent",
  "folderkey",
  "foldercontent",
]);
const NONCE_BYTES = 12;
const OVERHEAD = NONCE_BYTES + 16;
const MAX_BASE64 = 4 * Math.ceil((PROTON_ITEM_MAX_BYTES + OVERHEAD) / 3);
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class ProtonCryptoError extends Error {
  constructor(
    readonly code:
      | "configuration"
      | "format"
      | "authentication"
      | "stale"
      | "limit",
  ) {
    super("The Proton Pass encrypted value could not be used.");
    this.name = "ProtonCryptoError";
  }
}

function current(owner: ProtonCryptoOwner): void {
  if (owner.signal.aborted) throw new ProtonCryptoError("stale");
  owner.assertCurrent();
  if (owner.signal.aborted) throw new ProtonCryptoError("stale");
}

function checkedKey(key: CryptoKey, usage: "encrypt" | "decrypt"): void {
  if (
    key.type !== "secret" ||
    key.extractable ||
    key.algorithm.name !== "AES-GCM" ||
    !("length" in key.algorithm) ||
    key.algorithm.length !== 256 ||
    !key.usages.includes(usage)
  )
    throw new ProtonCryptoError("configuration");
}

function additionalData(tag: ProtonEncryptionTag): Uint8Array {
  if (!TAGS.has(tag)) throw new ProtonCryptoError("configuration");
  return new TextEncoder().encode(tag);
}

function envelope(value: string): Uint8Array {
  if (value.length > MAX_BASE64) throw new ProtonCryptoError("limit");
  if (value.length % 4 !== 0 || !STANDARD_BASE64.test(value))
    throw new ProtonCryptoError("format");
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(value);
  } catch {
    throw new ProtonCryptoError("format");
  }
  if (
    bytes.length < OVERHEAD ||
    bytes.length > PROTON_ITEM_MAX_BYTES + OVERHEAD ||
    bytesToB64(bytes) !== value
  )
    throw new ProtonCryptoError("format");
  return bytes;
}

/** Direct PAT/share/item AES key import; the protocol adds no HKDF derivation. */
export async function importProtonKey(
  raw: Uint8Array,
  owner: ProtonCryptoOwner,
): Promise<CryptoKey> {
  current(owner);
  if (raw.length !== 32) throw new ProtonCryptoError("configuration");
  const temporary = raw.slice();
  const owned = ownBytes(temporary);
  try {
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "raw",
        owned,
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
    } catch {
      current(owner);
      throw new ProtonCryptoError("configuration");
    }
    current(owner);
    return key;
  } finally {
    temporary.fill(0);
    owned.fill(0);
  }
}

/** Strict IV||ciphertext||128-bit-tag envelope, bound to its exact protocol tag. */
export async function openProtonValue(
  value: string,
  key: CryptoKey,
  tag: ProtonEncryptionTag,
  owner: ProtonCryptoOwner,
): Promise<Uint8Array> {
  current(owner);
  checkedKey(key, "decrypt");
  const aad = additionalData(tag);
  const bytes = envelope(value);
  let plain: Uint8Array | undefined;
  let returned = false;
  try {
    try {
      plain = await gcmOpen(
        key,
        bytes.subarray(0, NONCE_BYTES),
        bytes.subarray(NONCE_BYTES),
        aad,
      );
    } catch {
      current(owner);
      throw new ProtonCryptoError("authentication");
    }
    current(owner);
    returned = true;
    return plain;
  } finally {
    if (!returned) plain?.fill(0);
  }
}

/** Every write receives a fresh CSPRNG nonce; temporary plaintext is always wiped. */
export async function sealProtonValue(
  value: Uint8Array,
  key: CryptoKey,
  tag: ProtonEncryptionTag,
  owner: ProtonCryptoOwner,
): Promise<string> {
  current(owner);
  checkedKey(key, "encrypt");
  const aad = additionalData(tag);
  if (value.length > PROTON_ITEM_MAX_BYTES)
    throw new ProtonCryptoError("limit");
  const temporary = value.slice();
  try {
    const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    let body: Uint8Array;
    try {
      body = await gcmSeal(key, temporary, iv, aad);
    } catch {
      current(owner);
      throw new ProtonCryptoError("authentication");
    }
    current(owner);
    const sealed = new Uint8Array(iv.length + body.length);
    sealed.set(iv);
    sealed.set(body, iv.length);
    return bytesToB64(sealed);
  } finally {
    temporary.fill(0);
  }
}
