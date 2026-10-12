import { expect, it } from "vitest";
import {
  nativeVercelAuthorizationUrl,
  parseNativeVercelWebMessage,
} from "./native-vercel-auth.js";
import { vercelPending } from "./native-vercel.test-helper.js";

it.each(["query", "web_message.opener"] as const)(
  "Vercel %s consent binds a public-client code to PKCE, nonce and the originating transaction",
  async (mode) => {
    const pending = vercelPending();
    const url = new URL(await nativeVercelAuthorizationUrl(pending, mode));
    expect(url.origin + url.pathname).toBe(
      "https://vercel.com/oauth/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: pending.clientId,
      response_type: "code",
      response_mode: mode,
      state: pending.state,
      nonce: pending.state,
      redirect_uri: pending.redirectUri,
      scope: "openid email profile",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(url.href).not.toContain(pending.verifier);
    expect(url.searchParams.has("client_secret")).toBe(false);
  },
);

it.each([
  { issuer: "https://attacker.example" },
  { endpoint: "https://attacker.example/token" },
  {
    redirectUri:
      "https://selfhost.example/auth/native-connector.html?recipient=other",
  },
  { scopes: ["openid", "deployments:write"] },
  { scopes: ["profile"] },
  { clientId: "" },
])(
  "Vercel rejects changed bindings and unapproved resource scopes before navigation: %j",
  async (change) => {
    await expect(
      nativeVercelAuthorizationUrl({ ...vercelPending(), ...change }, "query"),
    ).rejects.toThrow();
  },
);

it("accepts the documented provider authorization response but drops provider prose", () => {
  const state = vercelPending().state;
  expect(parseNativeVercelWebMessage({ state, code: "one-use-code" })).toEqual({
    state,
    code: "one-use-code",
    error: false,
  });
  expect(
    parseNativeVercelWebMessage({
      state,
      error: "access_denied",
      error_description: "untrusted prose",
    }),
  ).toEqual({ state, code: null, error: true });
});
it.each([
  null,
  "code=one",
  { state: "short", code: "one" },
  { state: "s".repeat(43) },
  { state: "s".repeat(43), code: "one", error: "denied" },
  { state: "s".repeat(43), code: "a".repeat(8193) },
])("refuses malformed or ambiguous popup data: %j", (value) => {
  expect(parseNativeVercelWebMessage(value)).toBeNull();
});
