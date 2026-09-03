import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { safeAgentAuthReturnTo } from "../ui/agent-auth-pages.js";

/**
 * Seeded parser fuzz for AgentAuth request discriminators and return_to.
 * Lives next to the routes rather than packages/fuzz so it can drive Hono
 * without inverting the package dependency graph. The Jazzer targets cover
 * the token and contract parsers.
 */

function makeRng(seed: number): () => number {
  let x = seed || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

function randomString(rng: () => number, maxLen: number): string {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyz0123456789-_=+/\\{}[]":,. \n\té中😀';
  const len = Math.floor(rng() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(rng() * alphabet.length)] ?? "a";
  }
  return out;
}

describe("AgentAuth fuzz", () => {
  it("register never throws on arbitrary JSON bodies", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const rng = makeRng(0x51fed);
    for (let i = 0; i < 64; i++) {
      const bodies: unknown[] = [
        randomString(rng, 80),
        { type: randomString(rng, 12) },
        { type: "anonymous", extra: randomString(rng, 40) },
        { type: "service_auth", login_hint: randomString(rng, 40) },
        { type: "identity_assertion", assertion: randomString(rng, 40) },
        null,
        [],
      ];
      const body = bodies[Math.floor(rng() * bodies.length)];
      const res = await app.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(500);
    }
  });

  it("safeAgentAuthReturnTo never yields an off-site href", () => {
    const rng = makeRng(0xc1a17);
    for (let i = 0; i < 128; i++) {
      const value = randomString(rng, 64);
      const out = safeAgentAuthReturnTo(value);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(out.includes("://")).toBe(false);
      expect(out.includes("\\")).toBe(false);
    }
  });
});
