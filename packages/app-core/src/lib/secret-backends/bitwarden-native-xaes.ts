import { ecb, gcm } from "@noble/ciphers/aes.js";

/** Codec allocation policy, below the algorithm's theoretical input limits. */
export const MAX_BITWARDEN_XAES_PLAINTEXT_BYTES = 4 * 1024 * 1024;
export const MAX_BITWARDEN_XAES_AAD_BYTES = 64 * 1024;

/**
 * C2SP XAES-256-GCM: the fixed two-block SP800-108r1 CMAC counter KDF.
 * AES itself and GCM are mature library primitives, not implemented here.
 */
function deriveSubkey(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  let l: Uint8Array | undefined;
  const mask = new Uint8Array(16);
  const blocks = new Uint8Array(32);
  try {
    l = ecb(key, { disablePadding: true }).encrypt(new Uint8Array(16));
    for (let index = 0; index < 16; index++)
      mask[index] = (l[index] << 1) | ((l[index + 1] ?? 0) >>> 7);
    mask[15] ^= (0 - (l[0] >>> 7)) & 0x87;
    blocks[1] = 1;
    blocks[17] = 2;
    blocks[2] = blocks[18] = 0x58;
    blocks.set(nonce.subarray(0, 12), 4);
    blocks.set(nonce.subarray(0, 12), 20);
    for (let index = 0; index < blocks.length; index++)
      blocks[index] ^= mask[index % 16];
    return ecb(key, { disablePadding: true }).encrypt(blocks);
  } finally {
    l?.fill(0);
    mask.fill(0);
    blocks.fill(0);
  }
}

function checkInputs(
  body: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  maximumBody: number,
): void {
  if (
    !(body instanceof Uint8Array) ||
    body.length > maximumBody ||
    !(key instanceof Uint8Array) ||
    key.length !== 32 ||
    !(nonce instanceof Uint8Array) ||
    nonce.length !== 24 ||
    !(aad instanceof Uint8Array) ||
    aad.length > MAX_BITWARDEN_XAES_AAD_BYTES
  )
    throw new Error("Invalid Bitwarden XAES input.");
}

function transform(
  body: Uint8Array,
  key32: Uint8Array,
  nonce24: Uint8Array,
  associatedData: Uint8Array,
  opening: boolean,
): Uint8Array {
  let key: Uint8Array | undefined;
  let nonce: Uint8Array | undefined;
  let aad: Uint8Array | undefined;
  let ownBody: Uint8Array | undefined;
  let subkey: Uint8Array | undefined;
  try {
    checkInputs(
      body,
      key32,
      nonce24,
      associatedData,
      MAX_BITWARDEN_XAES_PLAINTEXT_BYTES + (opening ? 16 : 0),
    );
    if (opening && body.length < 16)
      throw new Error("Invalid Bitwarden XAES input.");
    key = new Uint8Array(key32);
    nonce = new Uint8Array(nonce24);
    aad = new Uint8Array(associatedData);
    ownBody = new Uint8Array(body);
    subkey = deriveSubkey(key, nonce);
    const cipher = gcm(subkey, nonce.subarray(12), aad);
    return opening ? cipher.decrypt(ownBody) : cipher.encrypt(ownBody);
  } catch {
    throw new Error(
      opening
        ? "Bitwarden XAES ciphertext could not be opened."
        : "Bitwarden XAES ciphertext could not be sealed.",
    );
  } finally {
    key?.fill(0);
    nonce?.fill(0);
    aad?.fill(0);
    ownBody?.fill(0);
    subkey?.fill(0);
  }
}

/**
 * Primitive for V2 COSE wrapping; output is ciphertext followed by tag16.
 * The owner must generate a fresh random nonce24 per write and supply the
 * exact COSE AAD. This primitive does not parse/validate COSE or key usage.
 */
export function sealBitwardenXaes(
  plaintext: Uint8Array,
  key32: Uint8Array,
  nonce24: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  return transform(plaintext, key32, nonce24, aad, false);
}

/** Authenticating open only; no plaintext is returned on tag/AAD failure. */
export function openBitwardenXaes(
  ciphertext: Uint8Array,
  key32: Uint8Array,
  nonce24: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  return transform(ciphertext, key32, nonce24, aad, true);
}
