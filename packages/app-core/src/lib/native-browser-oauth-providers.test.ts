import { expect, it, vi } from "vitest";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
} from "./native-browser-oauth-connectors.js";
import { nativeBrowserOAuthVerificationEndpoint } from "./native-browser-oauth-resources.js";
import { nativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import { nativeConfigurationBrowserPolicy } from "./native-configuration-policy.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  microsoftAccount,
  microsoftAssertion,
} from "./native-oauth-jwt.test-support.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
  oauthPending,
} from "./native-oauth.test-support.js";

function expectProviderResourceRequest(
  provider: ReturnType<typeof oauthAuthority>,
  id: string,
) {
  const request = provider.fetch.mock.calls[1];
  if (!request) throw new Error("Actual provider resource request missing");
  const [endpoint, init] = request;
  if (!init) throw new Error("Actual provider resource options missing");
  expect(String(endpoint)).toBe(nativeBrowserOAuthVerificationEndpoint(id));
  expect(init.method).toBe(id === "dropbox" ? "POST" : "GET");
  expect(init.body).toBe(id === "dropbox" ? "null" : undefined);
  expect(new Headers(init.headers).get("content-type")).toBe(
    id === "dropbox" ? "application/json" : null,
  );
}
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
    expectProviderResourceRequest(provider, profile.id);
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
    expect(input.parameters.tenant).toBe("organizations");
  },
);

it("canonicalizes a mixed-case Microsoft tenant selector before verification", async () => {
  const provider = oauthAuthority("microsoft");
  const input = oauthDraft("microsoft");
  input.parameters.tenant = "Organizations";
  const draft = await configureNativeBrowserOAuthConnector(input);
  await beginNativeBrowserAuthorization(draft.connectionId);
  const signed = await microsoftAssertion(
    oauthPending(draft.connectionId).state,
  );
  provider.replies.push(
    {
      body: {
        access_token: "private-microsoft-access",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid https://graph.microsoft.com/User.Read",
        id_token: signed.token,
      },
    },
    { body: signed.jwks },
    { body: { id: microsoftAccount, displayName: "Real Microsoft account" } },
  );
  await expect(
    finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
  ).resolves.toMatchObject({ status: "connected" });
});

it("refuses a consumer tenant when the selector is a mixed-case organizations", async () => {
  const provider = oauthAuthority("microsoft");
  const input = oauthDraft("microsoft");
  input.parameters.tenant = "Organizations";
  const draft = await configureNativeBrowserOAuthConnector(input);
  await beginNativeBrowserAuthorization(draft.connectionId);
  const signed = await microsoftAssertion(
    oauthPending(draft.connectionId).state,
    {
      tid: "9188040d-6c67-4c5b-b112-36a304b66dad",
    },
  );
  provider.replies.push({
    body: {
      access_token: "consumer-access",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid User.Read",
      id_token: signed.token,
    },
  });
  await expect(
    finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
  ).rejects.toThrow();
});

function configuredCarrier() {
  let current = true;
  const lifetime = new AbortController();
  const allowed = new Set([
    "https://token.example",
    "https://resource.example",
  ]);
  const fetch = vi.fn(async () => {
    throw new Error("Policy inspection must not fetch");
  });
  const supportsNativeOrigin = vi.fn((origin: string) => allowed.has(origin));
  const transport: NativeProviderTransport = {
    fetch,
    signal: lifetime.signal,
    supportsNativeOrigin,
    assertCurrent: () => {
      if (!current) throw new Error("Original owner ended");
    },
  };
  return {
    transport,
    fetch,
    supportsNativeOrigin,
    allowed,
    lifetime,
    withdraw: () => {
      current = false;
    },
  };
}
const configuredTargets = {
  token_endpoint: "https://token.example/token",
  resource: "https://resource.example/data",
};
it("admits only the original carrier covering both configured token and resource origins without network", () => {
  const c = configuredCarrier();
  expect(nativeBrowserOAuthPolicy("resend").available).toBe(false);
  expect(
    nativeConfigurationBrowserPolicy(
      "resend",
      "oauth",
      configuredTargets,
      c.transport,
    ).available,
  ).toBe(true);
  expect(c.supportsNativeOrigin.mock.calls.map(([origin]) => origin)).toEqual([
    "https://token.example",
    "https://resource.example",
  ]);
  const ordinary: NativeProviderTransport = {
    fetch: c.fetch,
    assertCurrent: c.transport.assertCurrent,
    signal: c.lifetime.signal,
  };
  expect(
    nativeConfigurationBrowserPolicy(
      "resend",
      "oauth",
      { ...configuredTargets, supportsNativeOrigin: "true" },
      ordinary,
    ).available,
  ).toBe(false);
  expect(
    nativeConfigurationBrowserPolicy(
      "resend",
      "oauth",
      { token_endpoint: configuredTargets.token_endpoint },
      c.transport,
    ).available,
  ).toBe(false);
  expect(
    nativeConfigurationBrowserPolicy(
      "resend",
      "oauth",
      { resource: configuredTargets.resource },
      c.transport,
    ).available,
  ).toBe(false);
  expect(c.fetch).not.toHaveBeenCalled();
});
it.each(["https://token.example", "https://resource.example"])(
  "refuses missing original %s route without inspecting or fetching a later carrier",
  (origin) => {
    const c = configuredCarrier();
    c.allowed.delete(origin);
    expect(
      nativeConfigurationBrowserPolicy(
        "resend",
        "oauth",
        configuredTargets,
        c.transport,
      ).available,
    ).toBe(false);
    expect(c.fetch).not.toHaveBeenCalled();
  },
);
const invalidConfiguredTargets = [
  { token_endpoint: "https://token.example/token", resource: "" },
  { token_endpoint: "", resource: "https://resource.example/data" },
  { ...configuredTargets, token_endpoint: "http://token.example/token" },
  {
    ...configuredTargets,
    token_endpoint: "https://user:secret@token.example/token",
  },
  { ...configuredTargets, resource: "https://resource.example/data#fragment" },
];
it.each(invalidConfiguredTargets)(
  "refuses incomplete or invalid configured targets %j",
  (parameters) => {
    const c = configuredCarrier();
    expect(
      nativeConfigurationBrowserPolicy(
        "resend",
        "oauth",
        parameters,
        c.transport,
      ).available,
    ).toBe(false);
    expect(c.fetch).not.toHaveBeenCalled();
  },
);
it.each(["owner", "abort", "during-inspection"])(
  "refuses original carrier %s withdrawal before returning admission",
  (cause) => {
    const c = configuredCarrier();
    if (cause === "owner") c.withdraw();
    else if (cause === "abort") c.lifetime.abort();
    else
      c.transport.supportsNativeOrigin = () => {
        c.withdraw();
        return true;
      };
    expect(
      nativeConfigurationBrowserPolicy(
        "resend",
        "oauth",
        configuredTargets,
        c.transport,
      ).available,
    ).toBe(false);
    expect(c.fetch).not.toHaveBeenCalled();
  },
);
it("derives the existing Resend profile targets from the same endpoint map used by real verification", () => {
  const c = configuredCarrier();
  c.allowed.clear();
  c.allowed.add("https://api.resend.com");
  expect(
    nativeConfigurationBrowserPolicy("resend", "oauth", {}, c.transport)
      .available,
  ).toBe(true);
  expect(nativeBrowserOAuthVerificationEndpoint("resend")).toBe(
    "https://api.resend.com/domains",
  );
  expect(c.supportsNativeOrigin.mock.calls.map(([origin]) => origin)).toEqual([
    "https://api.resend.com",
    "https://api.resend.com",
  ]);
  expect(c.fetch).not.toHaveBeenCalled();
});
