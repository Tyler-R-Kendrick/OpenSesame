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

/** Uniform index in [0, max) without modulo bias (rejection sampling). */
function randomIndex(max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("randomIndex needs a positive bound");
  }
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  const view = new DataView(buf.buffer);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = view.getUint32(0);
  } while (value >= limit);
  return value % max;
}

export function mintUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[randomIndex(alphabet.length)] ?? "A";
    if (i === 3) out += "-";
  }
  return out;
}
