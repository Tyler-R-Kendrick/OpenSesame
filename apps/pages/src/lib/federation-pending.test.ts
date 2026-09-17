/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PKCE_KEY } from "./federation-pending.js";
import { completeSignIn } from "./federation.js";

function stubStorage(): void {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => {
      memory.clear();
    },
  });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  });
}

function seedPending(): void {
  localStorage.setItem(
    PKCE_KEY,
    JSON.stringify({
      upstreamId: "mock",
      issuer: "http://127.0.0.1:9090",
      verifier: "verifier-1",
      state: "state-1",
      tokenEndpoint: "http://127.0.0.1:9090/token",
      jwksUri: "http://127.0.0.1:9090/jwks",
      scope: "openid",
      createdAt: Date.now(),
    }),
  );
}

describe("legacy pending correlation", () => {
  beforeEach(() => {
    stubStorage();
    history.replaceState(null, "", "/");
  });
  afterEach(() => {
    history.replaceState(null, "", "/");
  });

  it("OIDC-ERROR-STATE: login_required without matching state does not consume pending", async () => {
    seedPending();
    history.replaceState(null, "", "/?error=login_required");
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(JSON.parse(localStorage.getItem(PKCE_KEY) ?? "null")?.state).toBe(
      "state-1",
    );
  });
});
