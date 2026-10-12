import { sha256Base64Url } from "@opensesame/sdk-browser";
import { expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
  invokeNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { nativeOAuthCallbackTarget } from "./native-oauth-session.js";
import {
  gitlabAccount,
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
  oauthPending,
  oauthToken,
} from "./native-oauth.test-support.js";

installNativeOAuthTests();
it("seals PKCE, exchanges without a secret, verifies the real provider account, and awaits a real account read", async () => {
  const provider = oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  expect(draft.status).toBe("configuration");
  expect(provider.fetch).not.toHaveBeenCalled();
  await beginNativeBrowserAuthorization(draft.connectionId);
  const pending = oauthPending(draft.connectionId);
  const consent = new URL(provider.navigate.mock.calls[0]?.[0] ?? "");
  expect(consent.origin + consent.pathname).toBe(
    "https://gitlab.com/oauth/authorize",
  );
  expect(consent.searchParams.get("code_challenge")).toBe(
    await sha256Base64Url(pending.verifier),
  );
  expect(consent.searchParams.get("state")).toBe(pending.state);
  expect(nativeOAuthCallbackTarget(oauthCallback(draft.connectionId))).toEqual({
    connectionId: draft.connectionId,
    providerId: "gitlab",
    method: "oauth",
    actor: "user",
  });
  provider.replies.push(
    { body: oauthToken() },
    { body: gitlabAccount },
    { body: gitlabAccount },
  );
  const callback = oauthCallback(draft.connectionId);
  const verified = await finishNativeBrowserAuthorization(callback);
  expect(verified.status).toBe("connected");
  expect(verified.identity).toMatchObject({
    id: "7",
    label: "Verified GitLab user",
    assurance: "account-verified",
  });
  const form = new URLSearchParams(
    String(provider.fetch.mock.calls[0]?.[1]?.body),
  );
  expect(form.get("code_verifier")).toBe(pending.verifier);
  expect(form.has("client_secret")).toBe(false);
  expect(
    new Headers(provider.fetch.mock.calls[0]?.[1]?.headers).has(
      "authorization",
    ),
  ).toBe(false);
  expect(JSON.stringify(readDeviceRows())).not.toContain("private-issued");
  expect(
    loadNativeConnectorRecord(draft.connectionId)?.privateState.grants.user
      ?.accessToken,
  ).toBe("private-issued-access");
  expect(
    await invokeNativeBrowserOAuthConnector(
      draft.connectionId,
      "provider.read",
    ),
  ).toEqual({ label: "Verified GitLab user", items: [] });
  await expect(finishNativeBrowserAuthorization(callback)).rejects.toThrow(
    "already used",
  );
  expect(provider.fetch).toHaveBeenCalledTimes(3);
  expect(provider.scrubCallback).toHaveBeenCalled();
});
it("does not consume a legitimate pending transaction or send credentials for forged or duplicate state", async () => {
  const provider = oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  const valid = oauthCallback(draft.connectionId);
  await expect(
    finishNativeBrowserAuthorization(
      `native_state=${"x".repeat(43)}&native_code=stolen`,
    ),
  ).rejects.toThrow();
  await expect(
    finishNativeBrowserAuthorization(`${valid}&native_state=ambiguous`),
  ).rejects.toThrow();
  expect(oauthCallback(draft.connectionId)).toBe(valid);
  expect(provider.fetch).not.toHaveBeenCalled();
});
it("preserves actual granted scopes and refuses insufficient consent before activating", async () => {
  const provider = oauthAuthority();
  const input = oauthDraft();
  input.requestedScopes.user = ["read_user", "read_api"];
  const draft = await configureNativeBrowserOAuthConnector(input);
  await beginNativeBrowserAuthorization(draft.connectionId);
  provider.replies.push(
    { body: oauthToken() },
    { body: gitlabAccount },
    { body: null },
    { body: null },
  );
  await expect(
    finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
  ).rejects.toThrow("selected permissions");
  expect(readNativeConnector(draft.connectionId)?.status).toBe("configuration");
  expect(
    loadNativeConnectorRecord(draft.connectionId)?.privateState.grants,
  ).toEqual({});
  expect(
    provider.fetch.mock.calls.slice(2).map((call) => String(call[0])),
  ).toEqual([
    "https://gitlab.com/oauth/revoke",
    "https://gitlab.com/oauth/revoke",
  ]);
});
it("does not activate or discard a rejected grant when provider cleanup fails", async () => {
  const provider = oauthAuthority();
  const input = oauthDraft();
  input.targetIds = { account: "a-different-user" };
  const draft = await configureNativeBrowserOAuthConnector(input);
  await beginNativeBrowserAuthorization(draft.connectionId);
  provider.replies.push(
    { body: oauthToken() },
    { body: gitlabAccount },
    { body: null, status: 503 },
  );
  await expect(
    finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
  ).rejects.toThrow();
  const record = loadNativeConnectorRecord(draft.connectionId);
  expect(record?.privateState.recovery[0]?.grant?.accessToken).toBe(
    "private-issued-access",
  );
  expect(record?.privateState.recovery[0]?.grant?.refreshToken).toBe(
    "private-issued-refresh",
  );
  expect(readNativeConnector(draft.connectionId)?.status).toBe("cleanup");
  expect(JSON.stringify(readNativeConnector(draft.connectionId))).not.toContain(
    "private-issued",
  );
});
it("rejects confidential secrets and form-selected destinations before any provider request", async () => {
  const provider = oauthAuthority();
  const input = oauthDraft();
  input.credentials.client_secret = "never-send-this-secret";
  await expect(configureNativeBrowserOAuthConnector(input)).rejects.toThrow(
    "confidential",
  );
  input.credentials = {};
  input.parameters.token_endpoint = "https://attacker.example/token";
  await expect(configureNativeBrowserOAuthConnector(input)).rejects.toThrow(
    "Unknown",
  );
  expect(provider.fetch).not.toHaveBeenCalled();
});
