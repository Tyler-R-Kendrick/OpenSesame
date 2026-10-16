/** Lowercase hex SHA-256 of a root trust public key SPKI (DER). */

export async function fingerprintOfSpki(spkiDer: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", spkiDer);
  return bytesToLowerHex(new Uint8Array(digest));
}

export async function fingerprintOfSpkiB64(
  spkiB64: string,
): Promise<string | null> {
  try {
    const der = Uint8Array.from(atob(spkiB64), (c) => c.charCodeAt(0));
    return await fingerprintOfSpki(der);
  } catch {
    return null;
  }
}

export async function exportSpkiB64(publicKey: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToLowerHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
