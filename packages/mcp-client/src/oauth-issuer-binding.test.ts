import {
  type OAuthClientProvider,
  fetchToken,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it, vi } from "vitest";

const ISSUER = "https://trusted-auth.example";
const credentials: OAuthClientInformationMixed = {
  client_id: "public-client",
  client_secret: "FICTIONAL_CLIENT_PRIVATE",
  issuer: ISSUER,
};
function provider(
  clientInformation: () => OAuthClientInformationMixed | undefined,
): OAuthClientProvider {
  return {
    redirectUrl: "https://client.example/callback",
    clientMetadata: {
      redirect_uris: ["https://client.example/callback"],
      logo_uri: undefined,
      tos_uri: undefined,
    },
    clientInformation,
    tokens: () => undefined,
    saveTokens: () => {},
    redirectToAuthorization: () => {},
    saveCodeVerifier: () => {},
    codeVerifier: () => "fictional-verifier",
    prepareTokenRequest: () =>
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "FICTIONAL_REFRESH_PRIVATE",
      }),
  };
}

describe("MCP OAuth authorization-server credential binding", () => {
  it("rejects a server-selected different issuer before preparing or sending credentials", async () => {
    const client = provider(() => credentials);
    const prepare = vi.spyOn(client, "prepareTokenRequest");
    const fetcher = vi.fn(async () => new Response("{}"));
    await expect(
      fetchToken(client, "https://attacker.example", { fetchFn: fetcher }),
    ).rejects.toThrow("bound to authorization server");
    expect(prepare).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rechecks issuer binding when a provider supplies credentials during request preparation", async () => {
    let stored: OAuthClientInformationMixed | undefined;
    const client = provider(() => stored);
    client.prepareTokenRequest = () => {
      stored = credentials;
      return new URLSearchParams({ grant_type: "client_credentials" });
    };
    const fetcher = vi.fn(async () => new Response("{}"));
    await expect(
      fetchToken(client, "https://attacker.example", { fetchFn: fetcher }),
    ).rejects.toThrow("bound to authorization server");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("allows the exact issuer to receive its existing credentials and refresh token", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(`${ISSUER}/token`);
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Basic ${btoa("public-client:FICTIONAL_CLIENT_PRIVATE")}`,
        );
        expect(String(init?.body)).toContain(
          "refresh_token=FICTIONAL_REFRESH_PRIVATE",
        );
        return new Response(
          JSON.stringify({
            access_token: "FICTIONAL_ACCESS_PRIVATE",
            token_type: "Bearer",
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );
    expect(
      await fetchToken(
        provider(() => credentials),
        ISSUER,
        { fetchFn: fetcher },
      ),
    ).toMatchObject({ token_type: "Bearer" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
