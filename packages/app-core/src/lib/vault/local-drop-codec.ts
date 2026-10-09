/**
 * Digests and bearer parsing for the device-local drop claim plane.
 * Split from `local-drop-claims.ts` so that file stays inside the size budget.
 */

import { bytesToB64url } from "@opensesame/sdk-browser";

const BEARER_PREFIX = "osc_clm_";

export function claimIdFromBearer(bearerToken: string): string | null {
  const parts = bearerToken.split(".");
  if (parts.length !== 2 || !parts[0]?.startsWith(BEARER_PREFIX)) return null;
  const claimId = parts[0].slice(BEARER_PREFIX.length);
  return claimId.length > 0 ? claimId : null;
}

export async function sha256Url(parts: string[]): Promise<string> {
  const joined = new TextEncoder().encode(parts.join("\0"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
  return bytesToB64url(digest);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function mintUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    // SAFETY: bytes[i] is defined for i < length.
    const b = bytes[i] ?? 0;
    out += alphabet[b % alphabet.length] ?? "A";
    if (i === 3) out += "-";
  }
  return out;
}
