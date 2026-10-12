import { expect, it } from "vitest";
import { vi } from "vitest";
import { kvSeams } from "./kv.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
} from "./native-browser-oauth-connectors.js";
import { createNativeBrowserOAuthDriver } from "./native-browser-oauth-connectors.js";
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import {
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import type {
  NativeConfiguration,
  NativeRecovery,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  saveNativeConnector,
} from "./native-connector-store.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
} from "./native-oauth.test-support.js";

installNativeOAuthTests();
const clientId = "https://selfhost.example/auth/native-client.json";
function client() {
  return {
    client_id: clientId,
    client_name: "OpenSesame",
    redirect_uris: ["https://selfhost.example/auth/native-connector.html"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
function metadata(id: string) {
  const issuer =
    id === "workos" ? "https://signin.workos.com" : "https://api.resend.com";
  const prefix = id === "workos" ? "oauth2" : "oauth";
  return {
    issuer,
    authorization_endpoint: `${issuer}/${prefix}/authorize`,
    token_endpoint: `${issuer}/${prefix}/token`,
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  };
}
it.each([
  {
    id: "workos",
    scopes: "openid email",
    identity: { sub: "verified-workos-subject", email: "workos@example.test" },
    assurance: "account-verified",
    label: "workos@example.test",
  },
])(
  "$id validates published public CIMD metadata, exchanges PKCE, and proves real provider access",
  async (profile) => {
    const provider = oauthAuthority(profile.id);
    const input = oauthDraft(profile.id);
    input.parameters = {};
    const view = await configureNativeBrowserOAuthConnector(input);
    expect(view.configuration.clientId).toBe(clientId);
    provider.replies.push({ body: metadata(profile.id) }, { body: client() });
    await beginNativeBrowserAuthorization(view.connectionId);
    const consent = new URL(provider.navigate.mock.calls[0]?.[0] ?? "");
    expect(consent.searchParams.get("client_id")).toBe(clientId);
    provider.replies.push(
      { body: metadata(profile.id) },
      { body: client() },
      {
        body: {
          access_token: "private-cimd-access",
          refresh_token: "private-cimd-refresh",
          token_type: "Bearer",
          expires_in: 900,
          scope: profile.scopes,
        },
      },
      { body: profile.identity },
    );
    const connected = await finishNativeBrowserAuthorization(
      oauthCallback(view.connectionId),
    );
    expect(connected.status).toBe("connected");
    expect(connected.identity).toMatchObject({
      label: profile.label,
      assurance: profile.assurance,
    });
    const form = new URLSearchParams(
      String(provider.fetch.mock.calls[4]?.[1]?.body),
    );
    expect(form.get("client_id")).toBe(clientId);
    expect(form.has("client_secret")).toBe(false);
  },
);
it("refuses a malicious CIMD document before navigation or minting", async () => {
  const provider = oauthAuthority("workos");
  const input = oauthDraft("workos");
  input.parameters = {};
  const draft = await configureNativeBrowserOAuthConnector(input);
  provider.replies.push(
    { body: metadata("workos") },
    { body: { ...client(), client_secret: "not-a-public-client" } },
  );
  await expect(
    beginNativeBrowserAuthorization(draft.connectionId),
  ).rejects.toThrow("public-browser");
  expect(provider.navigate).not.toHaveBeenCalled();
  expect(readNativeConnector(draft.connectionId)?.status).toBe("configuration");
});
it("refuses Resend REST OAuth before HTTP, navigation or durable configuration", async () => {
  const provider = oauthAuthority("resend");
  const seal = vi.spyOn(kvSeams, "kvSetDurable");
  const input = oauthDraft("resend");
  input.parameters = {};
  expect(createNativeBrowserOAuthDriver().supports("resend")).toBe(true);
  await expect(configureNativeBrowserOAuthConnector(input)).rejects.toThrow(
    "domain API",
  );
  expect(provider.fetch).not.toHaveBeenCalled();
  expect(provider.navigate).not.toHaveBeenCalled();
  expect(seal).not.toHaveBeenCalled();
});
it("preserves provider-defined cleanup of an existing Resend refresh grant after new authorization is unavailable", async () => {
  const provider = oauthAuthority("resend");
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: "resend",
    method: "oauth",
    displayName: "Existing Resend",
    icon: "",
    parameters: {},
    clientId,
    requestedScopes: { user: ["full_access"] },
    targetIds: {},
    fingerprint: "a".repeat(64),
  };
  const obligation: NativeRecovery = {
    id: "existing-grant-cleanup",
    kind: "revoke",
    providerId: "resend",
    actor: "user",
    targetId: "resend",
    fingerprint: configuration.fingerprint,
    grant: {
      providerId: "resend",
      actor: "user",
      fingerprint: configuration.fingerprint,
      targetId: "resend",
      kind: "oauth",
      clientId,
      accessToken: "resend-issued-access",
      refreshToken: "resend-issued-refresh",
      expiresAt: null,
      scopes: ["full_access"],
    },
  };
  const privateState = emptyNativePrivate();
  privateState.recovery = [obligation];
  await saveNativeConnector(
    {
      connectionId: "existing-resend",
      configuration,
      runtime: emptyNativeRuntime(),
      privateState,
    },
    browserOAuthClassification(configuration),
  );
  provider.replies.push({ body: null, status: 503 });
  await expect(retryNativeConnectorCleanup("existing-resend")).rejects.toThrow(
    "cleanup",
  );
  expect(
    loadNativeConnectorRecord("existing-resend")?.privateState.recovery,
  ).toEqual([obligation]);
  provider.replies.push({ body: null });
  expect((await retryNativeConnectorCleanup("existing-resend")).status).toBe(
    "configuration",
  );
  expect(
    loadNativeConnectorRecord("existing-resend")?.privateState.recovery,
  ).toHaveLength(0);
  const form = new URLSearchParams(
    String(provider.fetch.mock.calls[1]?.[1]?.body),
  );
  expect(form.get("token")).toBe("resend-issued-refresh");
  expect(form.get("token_type_hint")).toBe("refresh_token");
  expect(form.get("client_id")).toBe(clientId);
  await removeNativeConnectorWithCleanup("existing-resend");
  expect(readNativeConnector("existing-resend")).toBeNull();
});
it("refuses a previously saved Resend callback before consuming its state or minting tokens, and permits local cancellation", async () => {
  const provider = oauthAuthority("resend");
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: "resend",
    method: "oauth",
    displayName: "Existing Resend consent",
    icon: "",
    parameters: {},
    clientId,
    requestedScopes: { user: ["full_access"] },
    targetIds: {},
    fingerprint: "b".repeat(64),
  };
  const privateState = emptyNativePrivate();
  privateState.pending.user = {
    providerId: "resend",
    actor: "user",
    fingerprint: configuration.fingerprint,
    issuer: "https://api.resend.com",
    endpoint: "https://api.resend.com/oauth/token",
    clientId,
    state: "s".repeat(43),
    verifier: "v".repeat(43),
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    scopes: ["full_access"],
  };
  await saveNativeConnector(
    {
      connectionId: "existing-resend-pending",
      configuration,
      runtime: emptyNativeRuntime(),
      privateState,
    },
    browserOAuthClassification(configuration),
  );
  const seal = vi.spyOn(kvSeams, "kvSetDurable");
  seal.mockClear();
  await expect(
    finishNativeBrowserAuthorization(oauthCallback("existing-resend-pending")),
  ).rejects.toThrow("domain API");
  await expect(
    beginNativeBrowserAuthorization("existing-resend-pending"),
  ).rejects.toThrow("domain API");
  expect(provider.fetch).not.toHaveBeenCalled();
  expect(provider.navigate).not.toHaveBeenCalled();
  expect(seal).not.toHaveBeenCalled();
  expect(
    loadNativeConnectorRecord("existing-resend-pending")?.privateState.pending
      .user,
  ).toEqual(privateState.pending.user);
  await removeNativeConnectorWithCleanup("existing-resend-pending");
  expect(readNativeConnector("existing-resend-pending")).toBeNull();
  expect(provider.fetch).not.toHaveBeenCalled();
});
