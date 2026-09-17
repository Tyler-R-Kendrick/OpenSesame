/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fenceLocalSignOut } from "./generation.js";
import {
  readStoredSessionSync,
  restoreAuthenticatedSession,
} from "./restoration.js";

beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  });
});

describe("authenticated restoration", () => {
  it("OIDC-RESTORE: suppression wins over unexpired stored JSON", async () => {
    fenceLocalSignOut();
    const raw = JSON.stringify({
      issuer: "https://idp.example",
      idToken: "a.b.c",
      audience: "spa",
      expiresAt: Date.now() + 60_000,
      pairwiseSub: "sub",
      upstreamId: "x",
      jwksUri: "https://idp.example/jwks",
    });
    const result = await restoreAuthenticatedSession(
      raw,
      {
        issuer: "https://idp.example",
        clientId: "spa",
        jwksUri: "https://idp.example/jwks",
      },
      fetch,
    );
    expect(result).toEqual({ kind: "rejected", reason: "suppressed" });
  });

  it("OIDC-CACHE: untrusted stored claims are not authenticated", async () => {
    const raw = JSON.stringify({
      issuer: "https://attacker.example",
      idToken: "a.b.c",
      audience: "spa",
      expiresAt: Date.now() + 60_000,
      verified: true,
      name: "Attacker",
    });
    const result = await restoreAuthenticatedSession(
      raw,
      {
        issuer: "https://idp.example",
        clientId: "spa",
        jwksUri: "https://idp.example/jwks",
      },
      fetch,
    );
    expect(result.kind).toBe("rejected");
  });

  it("OIDC-CACHE: JWT claims override mutated JSON name/sub/expiry", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = jwt({
      iss: "https://idp.example",
      sub: "jwt-sub",
      aud: "spa",
      exp,
      name: "FromJwt",
    });
    const raw = JSON.stringify({
      issuer: "https://idp.example",
      idToken: token,
      audience: "spa",
      expiresAt: Date.now() + 86_400_000,
      pairwiseSub: "json-sub",
      name: "FromJson",
      upstreamId: "x",
      jwksUri: "https://idp.example/jwks",
    });
    const identity = readStoredSessionSync(
      raw,
      (iss) => iss === "https://idp.example",
    );
    expect(identity?.pairwiseSub).toBe("jwt-sub");
    expect(identity?.name).toBe("FromJwt");
    expect(identity?.expiresAt).toBe(exp * 1000);
  });
});

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims),
  )}.sig`;
}
