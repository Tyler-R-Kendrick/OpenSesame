import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { AuthError, AuthorizationError } from "./errors.js";
import { introspectOpaqueAccessToken } from "./introspection.js";

const ENDPOINT = "https://issuer.example/introspect";
const TOKEN = "opaque-access-token-value";
const AUDIENCE = "https://api.example";

interface MockIntrospectionResponse {
  ok?: boolean;
  status?: number;
  json?: BoundaryValue;
  reject?: Error;
}

function mockFetch(response: MockIntrospectionResponse): typeof fetch {
  return async () => {
    if (response.reject) {
      throw response.reject;
    }
    return new Response(JSON.stringify(response.json), {
      status: response.status ?? (response.ok === false ? 500 : 200),
      headers: { "content-type": "application/json" },
    });
  };
}

describe("introspectOpaqueAccessToken", () => {
  it("returns active token metadata", async () => {
    const fetchImpl = mockFetch({
      json: {
        active: true,
        aud: AUDIENCE,
        sub: "user-1",
        scope: "openid profile",
        client_id: "rp-alpha",
      },
    });

    const result = await introspectOpaqueAccessToken(TOKEN, {
      introspectionEndpoint: ENDPOINT,
      audience: AUDIENCE,
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
        audience: AUDIENCE,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "token_inactive" });

    try {
      await introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        audience: AUDIENCE,
        fetch: fetchImpl,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      if (!(error instanceof AuthError)) throw error;
      expect(error.message).not.toContain(TOKEN);
    }
  });

  it("fails closed on network errors", async () => {
    const fetchImpl = mockFetch({
      reject: new Error("ECONNREFUSED"),
    });

    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        audience: AUDIENCE,
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
        audience: AUDIENCE,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "introspection_failed" });
  });

  it("fails closed on malformed JSON", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        audience: AUDIENCE,
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
        audience: AUDIENCE,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "introspection_failed" });
  });

  it("enforces required scopes with AuthorizationError", async () => {
    const fetchImpl = mockFetch({
      json: {
        active: true,
        aud: AUDIENCE,
        sub: "user-1",
        scope: "openid",
      },
    });

    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        audience: AUDIENCE,
        fetch: fetchImpl,
        requiredScopes: ["admin"],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    try {
      await introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        audience: AUDIENCE,
        fetch: fetchImpl,
        requiredScopes: ["admin"],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      if (!(error instanceof AuthorizationError)) throw error;
      expect(error.code).toBe("insufficient_scope");
      expect(error.message).not.toContain(TOKEN);
    }
  });

  it("sends Basic auth when client credentials are provided", async () => {
    let capturedAuth: string | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedAuth =
        new Headers(init?.headers).get("Authorization") ?? undefined;
      return new Response(
        JSON.stringify({ active: true, aud: AUDIENCE, sub: "user-1" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await introspectOpaqueAccessToken(TOKEN, {
      introspectionEndpoint: ENDPOINT,
      audience: AUDIENCE,
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
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(/https/i);
  });
  it.each([
    ["a different audience", { aud: "https://other.example" }],
    ["an audience list without ours", { aud: ["a", "https://other.example"] }],
    ["no audience at all", {}],
    ["a malformed audience", { aud: 42 }],
    ["an empty audience list", { aud: [] }],
  ])("refuses an active token with %s", async (_label, claims) => {
    const fetchImpl = mockFetch({
      json: { active: true, sub: "user-1", ...claims },
    });
    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        audience: AUDIENCE,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid_audience" });
  });

  it("accepts a token whose audience list names any configured audience", async () => {
    const fetchImpl = mockFetch({
      json: { active: true, sub: "user-1", aud: ["x", "https://b.example"] },
    });
    const result = await introspectOpaqueAccessToken(TOKEN, {
      introspectionEndpoint: ENDPOINT,
      audience: ["https://a.example", "https://b.example"],
      fetch: fetchImpl,
    });
    expect(result.sub).toBe("user-1");
  });

  it("refuses to run without a configured audience", async () => {
    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        audience: [],
        fetch: mockFetch({ json: { active: true, aud: AUDIENCE } }),
      }),
    ).rejects.toThrow(/audience/);
  });

  it("never follows a redirect from the introspection endpoint", async () => {
    let redirectMode: RequestRedirect | undefined;
    // Behaves as fetch does: "error" turns a 3xx into a network error, while
    // "follow" would have posted the token on to the Location.
    const fetchImpl: typeof fetch = async (_url, init) => {
      redirectMode = init?.redirect;
      if (init?.redirect === "error") throw new TypeError("redirect");
      return new Response(JSON.stringify({ active: true, aud: AUDIENCE }), {
        status: 200,
      });
    };
    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        audience: AUDIENCE,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "introspection_failed" });
    expect(redirectMode).toBe("error");

    const redirected = mockFetch({ status: 307, json: { active: true } });
    await expect(
      introspectOpaqueAccessToken(TOKEN, {
        introspectionEndpoint: ENDPOINT,
        audience: AUDIENCE,
        fetch: redirected,
      }),
    ).rejects.toMatchObject({ code: "introspection_failed" });
  });
});
