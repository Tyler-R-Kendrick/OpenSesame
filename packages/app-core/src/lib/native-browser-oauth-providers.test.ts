import { expect, it } from "vitest";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
} from "./native-browser-oauth-connectors.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
} from "./native-oauth.test-support.js";

installNativeOAuthTests();
it.each([
  {
    id: "dropbox",
    authorization: "https://www.dropbox.com/oauth2/authorize",
    token: "https://api.dropboxapi.com/oauth2/token",
    scopes: "account_info.read",
    identity: {
      account_id: "dbid:account1",
      email: "user@example.test",
      name: { display_name: "Dropbox owner" },
    },
    expectedId: "dbid:account1",
  },
  {
    id: "spotify",
    authorization: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    scopes: "user-read-private",
    identity: { id: "spotify-account1", display_name: "Spotify owner" },
    expectedId: "spotify-account1",
  },
])(
  "$id uses its own public protocol and actual provider account",
  async (profile) => {
    const provider = oauthAuthority(profile.id);
    const draft = await configureNativeBrowserOAuthConnector(
      oauthDraft(profile.id),
    );
    await beginNativeBrowserAuthorization(draft.connectionId);
    const consent = new URL(provider.navigate.mock.calls[0]?.[0] ?? "");
    expect(consent.origin + consent.pathname).toBe(profile.authorization);
    if (profile.id === "dropbox")
      expect(consent.searchParams.get("token_access_type")).toBe("online");
    provider.replies.push(
      {
        body: {
          access_token: "provider-specific-private-access",
          token_type: "Bearer",
          expires_in: 3600,
          scope: profile.scopes,
        },
      },
      { body: profile.identity },
    );
    const view = await finishNativeBrowserAuthorization(
      oauthCallback(draft.connectionId),
    );
    expect(String(provider.fetch.mock.calls[0]?.[0])).toBe(profile.token);
    expect(
      new URLSearchParams(String(provider.fetch.mock.calls[0]?.[1]?.body)).has(
        "client_secret",
      ),
    ).toBe(false);
    expect(view.status).toBe("connected");
    expect(view.identity?.id).toBe(profile.expectedId);
    expect(view.grants[0]?.grantedScopes).toEqual([profile.scopes]);
    expect(JSON.stringify(view)).not.toContain(
      "provider-specific-private-access",
    );
  },
);
it("OpenRouter really exchanges PKCE for a key and verifies that key, without pretending to verify an account", async () => {
  const provider = oauthAuthority("openrouter");
  const input = oauthDraft("openrouter");
  input.parameters = {};
  const draft = await configureNativeBrowserOAuthConnector(input);
  await beginNativeBrowserAuthorization(draft.connectionId);
  const consent = new URL(provider.navigate.mock.calls[0]?.[0] ?? "");
  expect(consent.origin + consent.pathname).toBe("https://openrouter.ai/auth");
  expect(consent.searchParams.get("callback_url")).toBe(
    "https://selfhost.example/auth/native-connector.html",
  );
  provider.replies.push(
    { body: { key: "sk-or-private-provider-key" } },
    { body: { data: { label: "Self-hosted app key" } } },
  );
  const view = await finishNativeBrowserAuthorization(
    oauthCallback(draft.connectionId),
  );
  expect(String(provider.fetch.mock.calls[0]?.[0])).toBe(
    "https://openrouter.ai/api/v1/auth/keys",
  );
  expect(
    JSON.parse(String(provider.fetch.mock.calls[0]?.[1]?.body)),
  ).toMatchObject({
    code: "one-use-provider-code",
    code_challenge_method: "S256",
  });
  expect(String(provider.fetch.mock.calls[1]?.[0])).toBe(
    "https://openrouter.ai/api/v1/key",
  );
  expect(view.status).toBe("connected");
  expect(view.identity).toMatchObject({
    label: "Self-hosted app key",
    assurance: "credential-valid",
    kind: "authorized-key",
  });
  expect(view.grants[0]?.permissionState).toBe("provider-managed");
});
it.each(["microsoft", "microsoft-teams"])(
  "%s requests a public SPA code and binds signed verification to its tenant",
  async (id) => {
    const provider = oauthAuthority(id);
    const input = oauthDraft(id);
    input.parameters.tenant = "organizations";
    const draft = await configureNativeBrowserOAuthConnector(input);
    await beginNativeBrowserAuthorization(draft.connectionId);
    const consent = new URL(provider.navigate.mock.calls[0]?.[0] ?? "");
    expect(consent.origin + consent.pathname).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    );
    expect(consent.searchParams.get("nonce")).toBe(
      consent.searchParams.get("state"),
    );
    expect(consent.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "User.Read",
    ]);
  },
);
