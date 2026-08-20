import { describe, expect, it } from "vitest";
import { AuthError, AuthorizationError } from "./errors.js";
import { introspectOpaqueAccessToken } from "./introspection.js";
import { overlapCast } from "@opensesame/os-domain";

const ENDPOINT = "https://issuer.example/introspect";
const TOKEN = "opaque-access-token-value";

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  reject?: Error;
}): typeof fetch {
  const impl = async () => {
    if (response.reject) {
      throw response.reject;
    }
    return overlapCast({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json,
    });
  };
  return overlapCast(impl);
}

describe("introspectOpaqueAccessToken", () => {
  it("returns active token metadata", async () => {
    const fetchImpl = mockFetch({
      json: {
        active: true,
        sub: "user-1",
        scope: "openid profile",
        client_id: "rp-alpha",
      },
    });

    const result = await introspectOpaqueAccessToken(TOKEN, {
      introspectionEndpoint: ENDPOINT,
      clientId: "rp-alpha",
      clientSecret: "secret",
      fetch: fetchImpl,
    });

    expect(result.active).toBe(true);
    expect(result.sub).toBe("user-1");
    expect(result.scope).toBe("openid profile");
  });

  it("rejects inactive tokens", async () => {
    const fetchImpl = mockFetch({
      json: { active: false },
    });

    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "token_inactive" });

    try {
      await introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        fetch: fetchImpl,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((overlapCast(error)).message).not.toContain(TOKEN);
    }
  });

  it("fails closed on network errors", async () => {
    const fetchImpl = mockFetch({
      reject: new Error("ECONNREFUSED"),
    });

    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "introspection_failed" });
  });

  it("fails closed on non-OK HTTP responses", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 503,
      json: { error: "server_error" },
    });

    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "introspection_failed" });
  });

  it("fails closed on malformed JSON", async () => {
    const fetchImpl: typeof fetch = async () =>
      overlapCast({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      });

    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "introspection_failed" });
  });

  it("fails closed when active claim is missing", async () => {
    const fetchImpl = mockFetch({
      json: { sub: "user-1" },
    });

    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "introspection_failed" });
  });

  it("enforces required scopes with AuthorizationError", async () => {
    const fetchImpl = mockFetch({
      json: {
        active: true,
        sub: "user-1",
        scope: "openid",
      },
    });

    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        fetch: fetchImpl,
        requiredScopes: ["admin"],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    try {
      await introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        fetch: fetchImpl,
        requiredScopes: ["admin"],
      });
    } catch (error) {
      expect((overlapCast(error)).code).toBe("insufficient_scope");
      expect((overlapCast(error)).message).not.toContain(TOKEN);
    }
  });

  it("sends Basic auth when client credentials are provided", async () => {
    let capturedAuth: string | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedAuth = (overlapCast(init?.headers)).Authorization;
      return overlapCast({
        ok: true,
        status: 200,
        json: async () => ({ active: true, sub: "user-1" }),
      });
    };

    await introspectOpaqueAccessToken(TOKEN, {
      introspectionEndpoint: ENDPOINT,
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetchImpl,
    });

    expect(capturedAuth).toBe(
      `Basic ${Buffer.from("client-id:client-secret", "utf8").toString("base64")}`,
    );
  });

  it("refuses a cleartext introspection endpoint", async () => {
    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: "http://idp.example/introspect",
      }),
    ).rejects.toThrow(/https/i);
  });
});
