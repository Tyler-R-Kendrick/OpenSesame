/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ambientAuthSeams,
  resetAmbientAuthSeams,
} from "../ambient-auth-seam.js";
import {
  type UpstreamIdentity,
  loadSession,
  originClientId,
  saveSession,
} from "../federation.js";
import { fenceLocalSignOut, isAutoAuthSuppressed } from "./generation.js";

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(claims: JsonObject): string {
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims),
  )}.signature`;
}

function identity(overrides: Partial<UpstreamIdentity> = {}): UpstreamIdentity {
  return {
    issuer: "https://shoo.dev",
    upstreamId: "shoo",
    idToken: "token",
    pairwiseSub: "pairwise-1",
    audience: originClientId(),
    jwksUri: "https://shoo.dev/jwks",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

// Suppression is the ambient capability's fence, so core restoration reads
// it through the seam. These cases describe an installation that approved
// ambient SSO, so they install the real check the way the module does.
beforeEach(() => {
  ambientAuthSeams.autoAuthSuppressed = isAutoAuthSuppressed;
});
afterEach(resetAmbientAuthSeams);

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
    clear: () => memory.clear(),
  });
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => {
      session.set(key, value);
    },
    removeItem: (key: string) => {
      session.delete(key);
    },
    clear: () => session.clear(),
  });
});

describe("loadSession shipped path", () => {
  it("OIDC-CACHE: mutated JSON cannot authenticate a JWT session", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    saveSession(
      identity({
        idToken: jwt({
          iss: "https://shoo.dev",
          sub: "jwt-sub",
          aud: originClientId(),
          exp,
          name: "FromJwt",
        }),
        pairwiseSub: "json-sub",
        name: "FromJson",
        expiresAt: Date.now() + 86_400_000,
      }),
    );
    expect(loadSession()?.pairwiseSub).toBe("jwt-sub");
    expect(loadSession()?.name).toBe("FromJwt");
  });

  it("OIDC-RESTORE: suppression wins over an unexpired stored session", () => {
    saveSession(identity());
    fenceLocalSignOut();
    expect(loadSession()).toBeNull();
  });

  it("OIDC-TIME: JSON expiresAt cannot extend an expired JWT", () => {
    saveSession(
      identity({
        idToken: jwt({
          iss: "https://shoo.dev",
          sub: "jwt-sub",
          aud: originClientId(),
          exp: Math.floor(Date.now() / 1000) - 10,
        }),
        expiresAt: Date.now() + 86_400_000,
      }),
    );
    expect(loadSession()).toBeNull();
  });
});
