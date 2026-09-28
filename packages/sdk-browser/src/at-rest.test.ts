/**
 * Nothing the browser client keeps rests in the clear (ADR 0149): the PKCE
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

  it("refuses to sign in when the origin can keep no key, storing nothing", async () => {
    useClientAtRestKeys(() => Promise.reject(new Error("no IndexedDB")));
    const storage = memory();
    const { sesame, assign } = client(storage);
    await expect(sesame.signIn({ returnTo: "/after" })).rejects.toThrow(
      /no storage key/,
    );
    expect(assign).not.toHaveBeenCalled();
    expect(storage.map.size).toBe(0);
  });

  it("lets only one of two racing callbacks spend the verifier", async () => {
    const storage = memory();
    const { sesame, assign } = client(storage);
    await sesame.signIn();
    const state = new URL(assign.mock.calls[0]?.[0]).searchParams.get("state");
    const callback = `https://rp.example/callback?code=c&state=${state}`;
    const next = client(storage).sesame;
    const [one, two] = await Promise.allSettled([
      next.handleRedirectCallback(callback),
      next.handleRedirectCallback(callback),
    ]);
    const missing = [one, two].filter(
      (r) =>
        r.status === "rejected" &&
        /Missing authorization/.test(String(r.reason)),
    );
    expect(missing).toHaveLength(1);
  });

  it("resolves the return path without a callback", async () => {
    const storage = memory();
    await client(storage).sesame.signIn({ returnTo: "/after" });
    expect(await client(storage).sesame.resolveReturnTo()).toBe("/after");
  });
});
