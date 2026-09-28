/**
 * Nothing the browser client keeps rests in the clear (ADR 0148): the PKCE
 * transaction and the session reach the RP's storage sealed, the return path
 * comes back through the callback, and an origin that can keep no key keeps
 * nothing at all.
 */
import { useClientAtRestKeys } from "@opensesame/browser-at-rest";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenSesame } from "./client.js";
import { opened } from "./test/at-rest-key.js";

const ISSUER = "https://id.example";
const key = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
  "encrypt",
  "decrypt",
]);

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

function client(storage: ReturnType<typeof memory>) {
  const assign = vi.fn();
  const sesame = createOpenSesame({
    issuer: ISSUER,
    clientId: "rp",
    redirectUri: "https://rp.example/callback",
    storage,
    windowLocation: overlapCast({ href: "https://rp.example/", assign }),
    fetchImpl: overlapCast(async () => Response.json(discovery)),
  });
  return { sesame, assign };
}

afterEach(() => useClientAtRestKeys(() => key));

describe("the browser client at rest", () => {
  it("seals the PKCE transaction and the return path", async () => {
    const storage = memory();
    const { sesame, assign } = client(storage);
    await sesame.signIn({ returnTo: "/after" });
    const state = new URL(assign.mock.calls[0]?.[0]).searchParams.get("state");
    for (const raw of storage.map.values()) {
      expect(raw).toMatch(/^osc1\./);
      expect(raw).not.toContain(`${state}`);
      expect(raw).not.toContain("/after");
    }
    expect(await opened(storage, "opensesame:pkce")).toContain(`${state}`);
    // The page after the redirect reads the return path back.
    const next = client(storage).sesame;
    await expect(
      next.handleRedirectCallback("https://rp.example/callback?error=denied"),
    ).rejects.toThrow("denied");
    expect(next.getReturnTo()).toBe("/after");
  });

  it("keeps nothing in the RP's storage when the origin can keep no key", async () => {
    useClientAtRestKeys(() => Promise.reject(new Error("no IndexedDB")));
    const storage = memory();
    const { sesame } = client(storage);
    await sesame.signIn({ returnTo: "/after" });
    expect(storage.map.size).toBe(0);
    expect(sesame.getReturnTo()).toBe("/after");
  });
});
