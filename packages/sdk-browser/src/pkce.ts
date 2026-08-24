/** Base64url encode without padding (RFC 7636). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

export async function createPkcePair(): Promise<PkcePair> {
  const codeVerifier = randomString(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  return {
    codeVerifier,
    codeChallenge,
    state: randomString(16),
    nonce: randomString(16),
  };
}
