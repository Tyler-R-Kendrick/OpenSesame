import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function pairwiseSub(canonicalSub: string, audience: string): string {
  return createHash("sha256")
    .update(`os-mock:${canonicalSub}:${audience}`)
    .digest("hex")
    .slice(0, 32);
}

export function tokenCorsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function pkceChallengesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function cryptoRandom(): string {
  return randomBytes(16).toString("hex");
}
