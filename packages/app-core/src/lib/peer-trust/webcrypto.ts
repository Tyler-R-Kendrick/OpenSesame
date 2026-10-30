import { isArrayBufferBackedBytes } from "@opensesame/os-domain";

/** P-256 ECDSA and SHA-256 helpers shared by enrollment and the session SAS. */

const ECDSA = { name: "ECDSA", hash: "SHA-256" } as const;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!isArrayBufferBackedBytes(bytes))
    throw new TypeError("Expected ArrayBuffer-backed bytes");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function bytesFromB64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) {
      bytes[at] = binary.charCodeAt(at);
    }
    return bytes;
  } catch {
    return null;
  }
}

export async function signP256(
  privateKey: CryptoKey,
  payload: Uint8Array,
): Promise<string | null> {
  try {
    if (!isArrayBufferBackedBytes(payload)) return null;
    const signature = await crypto.subtle.sign(ECDSA, privateKey, payload);
    return bytesToB64(new Uint8Array(signature));
  } catch {
    return null;
  }
}

export async function verifyP256(
  spkiB64: string,
  signatureB64: string,
  payload: Uint8Array,
): Promise<boolean> {
  const der = bytesFromB64(spkiB64);
  const signature = bytesFromB64(signatureB64);
  if (!der || !signature) return false;
  try {
    if (!isArrayBufferBackedBytes(payload)) return false;
    const publicKey = await crypto.subtle.importKey("spki", der, P256, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(ECDSA, publicKey, signature, payload);
  } catch {
    return false;
  }
}
