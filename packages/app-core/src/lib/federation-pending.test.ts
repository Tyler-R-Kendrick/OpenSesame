/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localStore, sessionStore } from "../ports.js";
import { PKCE_KEY, peekPending, storePending } from "./federation-pending.js";
import { completeSignIn } from "./federation.js";

const TEST_VERIFIER = "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789";

function stubStorage(): void {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => {
      local.set(key, value);
    },
    removeItem: (key: string) => {
      local.delete(key);
    },
    clear: () => {
      local.clear();
    },
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => {
      session.set(key, value);
    },
    removeItem: (key: string) => {
      session.delete(key);
    },
    clear: () => {
      session.clear();
    },
  });
}

function seedPending(): void {
  localStore().setItem(
    PKCE_KEY,
    JSON.stringify({
      upstreamId: "mock",
      issuer: "http://127.0.0.1:9090",
      verifier: TEST_VERIFIER,
      state: "state-ab12",
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

  it("PKCE-SWAP: conflicting local and session pending is refused and cleared", () => {
    seedPending();
    sessionStore().setItem(
      PKCE_KEY,
      JSON.stringify({
        upstreamId: "mock",
        issuer: "http://127.0.0.1:9090",
        verifier: TEST_VERIFIER,
        state: "other-state-9",
        tokenEndpoint: "http://127.0.0.1:9090/token",
        jwksUri: "http://127.0.0.1:9090/jwks",
        scope: "openid",
        createdAt: Date.now(),
      }),
    );
    expect(peekPending()).toEqual({ pending: null, stale: true });
    expect(localStore().getItem(PKCE_KEY)).toBeNull();
    expect(sessionStore().getItem(PKCE_KEY)).toBeNull();
  });

  it("PKCE-STORE: storePending drops a session-lane copy", () => {
    sessionStore().setItem(PKCE_KEY, '{"state":"old"}');
    storePending({
      upstreamId: "mock",
      issuer: "http://127.0.0.1:9090",
      verifier: TEST_VERIFIER,
      state: "state-new-1",
      tokenEndpoint: "http://127.0.0.1:9090/token",
      jwksUri: "http://127.0.0.1:9090/jwks",
      scope: "openid",
    });
    expect(sessionStore().getItem(PKCE_KEY)).toBeNull();
    expect(JSON.parse(localStore().getItem(PKCE_KEY) ?? "null")?.state).toBe(
      "state-new-1",
    );
  });

  it("OIDC-ERROR-STATE: login_required without matching state does not consume pending", async () => {
    seedPending();
    history.replaceState(null, "", "/?error=login_required");
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(JSON.parse(localStore().getItem(PKCE_KEY) ?? "null")?.state).toBe(
      "state-ab12",
    );
  });
});
