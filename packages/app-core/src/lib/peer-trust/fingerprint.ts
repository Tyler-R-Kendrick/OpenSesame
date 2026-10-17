/** Lowercase hex SHA-256 of a root trust public key SPKI (DER). */
import { bytesFromB64, bytesToB64, sha256Hex } from "./webcrypto.js";

export async function fingerprintOfSpki(spkiDer: Uint8Array): Promise<string> {
  return sha256Hex(spkiDer);
}

export async function fingerprintOfSpkiB64(
  spkiB64: string,
): Promise<string | null> {
  const der = bytesFromB64(spkiB64);
  if (!der) return null;
  return fingerprintOfSpki(der);
}

export async function exportSpkiB64(publicKey: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  return bytesToB64(der);
}
