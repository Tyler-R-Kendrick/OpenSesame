/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeSignIn, loadSession, originClientId } from "./federation.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";

const PKCE_KEY = "opensesame:federation:pkce";
const originalNetworkEligibility = localNetworkFetchSeams.eligible;

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(claims: JsonObject): string {
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims),
  )}.signature`;
}

function seedPending(overrides: JsonObject = {}): void {
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
      ...overrides,
    }),
  );
}

/** Node 22 shadows Storage with an unavailable experimental global. */
function ensureWebStorage(): void {
  const memory = (): Storage => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
      clear: () => {
        map.clear();
      },
      get length() {
        return map.size;
      },
      key: (index: number) => [...map.keys()][index] ?? null,
    };
  };
  vi.stubGlobal("localStorage", memory());
  vi.stubGlobal("sessionStorage", memory());
}

beforeEach(() => {
  ensureWebStorage();
  localNetworkFetchSeams.eligible = () => true;
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

afterEach(() => {
  localNetworkFetchSeams.eligible = originalNetworkEligibility;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("completeSignIn", () => {
  /**
   * "We actually have an authorized user" (docs.shoo.dev/server-verification):
   * Shoo's JWKS serves no CORS, so the ES256 signature cannot be verified in
   * this page — `POST /session/check` is the broker's signature- and
   * revocation-backed answer, and its explicit 401 refuses the sign-in.
   */
  describe("upstream session check", () => {
    const CHECK = "https://shoo.dev/session/check";

    function shooToken(): string {
      return jwt({
        iss: "https://shoo.dev",
        aud: originClientId(),
        exp: 4_000_000_000,
        pairwise_sub: "ps_sub-1",
      });
    }

    function seedShooPending(): void {
      seedPending({
        upstreamId: "shoo",
        issuer: "https://shoo.dev",
        tokenEndpoint: "https://shoo.dev/token",
        jwksUri: "https://shoo.dev/.well-known/jwks.json",
        sessionCheckEndpoint: CHECK,
      });
    }

    function stubExchangeThenCheck(check: () => Response) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input);
          calls.push({ url, init });
          if (url === CHECK) return Promise.resolve(check());
          return Promise.resolve(Response.json({ id_token: shooToken() }));
        }),
      );
      return calls;
    }

    it("asks the broker and passes an active session through", async () => {
      seedShooPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      const calls = stubExchangeThenCheck(() =>
        Response.json({ status: "active" }),
      );

      const result = await completeSignIn();

      expect(result?.identity.pairwiseSub).toBe("ps_sub-1");
      const check = calls.find((call) => call.url === CHECK);
      const headers = new Headers(check?.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${shooToken()}`);
      expect(loadSession()?.pairwiseSub).toBe("ps_sub-1");
    });

    it("refuses a sign-in the broker says is revoked, saving nothing", async () => {
      seedShooPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      stubExchangeThenCheck(
        () =>
          new Response(
            JSON.stringify({ status: "login_required", reason: "revoked" }),
            { status: 401 },
          ),
      );

      await expect(completeSignIn()).rejects.toMatchObject({
        code: "login_required",
      });
      expect(loadSession()).toBeNull();
    });

    it("does not block on a broker without the endpoint", async () => {
      seedShooPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      stubExchangeThenCheck(() => new Response("not here", { status: 404 }));

      const result = await completeSignIn();
      expect(result?.identity.pairwiseSub).toBe("ps_sub-1");
    });

    it("does not block on a transport failure after a good exchange", async () => {
      seedShooPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          if (String(input) === CHECK) {
            return Promise.reject(new TypeError("failed to fetch"));
          }
          return Promise.resolve(Response.json({ id_token: shooToken() }));
        }),
      );

      const result = await completeSignIn();
      expect(result?.identity.pairwiseSub).toBe("ps_sub-1");
    });

    it("posts a stolen pending record only to the compiled Shoo endpoints", async () => {
      seedPending({
        upstreamId: "shoo",
        issuer: "https://shoo.dev",
        verifier: "verifier-from-storage",
        tokenEndpoint: "https://attacker.example/token",
        sessionCheckEndpoint: "https://attacker.example/check",
        jwksUri: "https://attacker.example/jwks",
      });
      history.replaceState(null, "", "/?code=attacker-code&state=state-1");
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input);
          calls.push(url);
          if (url === "https://shoo.dev/session/check") {
            return Promise.resolve(Response.json({ status: "active" }));
          }
          expect(url).toBe("https://shoo.dev/token");
          const body = String(init.body ?? "");
          expect(body).toContain("code=attacker-code");
          expect(body).toContain("code_verifier=verifier-from-storage");
          return Promise.resolve(
            Response.json({
              id_token: jwt({
                iss: "https://shoo.dev",
                aud: originClientId(),
                exp: 4_000_000_000,
                pairwise_sub: "ps_real",
              }),
            }),
          );
        }),
      );

      const result = await completeSignIn();

      expect(result?.identity.pairwiseSub).toBe("ps_real");
      expect(result?.identity.jwksUri).toBe(
        "https://shoo.dev/.well-known/jwks.json",
      );
      expect(calls).toEqual([
        "https://shoo.dev/token",
        "https://shoo.dev/session/check",
      ]);
      expect(loadSession()?.jwksUri).toBe(
        "https://shoo.dev/.well-known/jwks.json",
      );
    });

    it("posts the mock issuer's code to the compiled loopback token endpoint", async () => {
      seedPending({
        tokenEndpoint: "https://attacker.example/token",
        jwksUri: "https://attacker.example/jwks",
      });
      history.replaceState(null, "", "/?code=attacker-code&state=state-1");
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        expect(String(input)).toBe("http://127.0.0.1:9090/token");
        return Promise.resolve(
          Response.json({
            id_token: jwt({
              iss: "http://127.0.0.1:9090",
              aud: originClientId(),
              exp: Date.now() / 1000 + 3600,
              pairwise_sub: "sub-1",
            }),
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await completeSignIn();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result?.identity.jwksUri).toBe("http://127.0.0.1:9090/jwks");
    });

    it("never calls a check endpoint an upstream does not declare", async () => {
      seedPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          Response.json({
            id_token: jwt({
              iss: "http://127.0.0.1:9090",
              aud: originClientId(),
              exp: Date.now() / 1000 + 3600,
              pairwise_sub: "sub-1",
            }),
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      await completeSignIn();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
