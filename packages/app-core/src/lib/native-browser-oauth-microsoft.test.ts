import { expect, it } from "vitest";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
} from "./native-browser-oauth-connectors.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import {
  microsoftAccount,
  microsoftAssertion,
  microsoftTenant,
} from "./native-oauth-jwt.test-support.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
  oauthPending,
} from "./native-oauth.test-support.js";

installNativeOAuthTests();
it("verifies Microsoft's signed tenant and the delegated Graph account before reporting connected", async () => {
  const provider = oauthAuthority("microsoft");
  const draft = await configureNativeBrowserOAuthConnector(
    oauthDraft("microsoft"),
  );
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
  const view = await finishNativeBrowserAuthorization(
    oauthCallback(draft.connectionId),
  );
  expect(view.status).toBe("connected");
  expect(view.identity?.id).toBe(`${microsoftTenant}:${microsoftAccount}`);
  expect(view.grants[0]?.grantedScopes).toEqual(["openid", "User.Read"]);
  expect(provider.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    `https://login.microsoftonline.com/${microsoftTenant}/discovery/v2.0/keys`,
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName",
  ]);
  expect(provider.fetch.mock.calls[0]?.[1]).toMatchObject({
    credentials: "omit",
    mode: "cors",
    redirect: "error",
  });
  expect(JSON.stringify(view)).not.toContain(signed.token);
});
it.each([
  { nonce: "wrong-nonce" },
  { aud: "other-client" },
  { oid: "33333333-3333-4333-8333-333333333333" },
])(
  "keeps a rejected minted Microsoft token sealed when signed account binding is wrong: %j",
  async (override) => {
    const provider = oauthAuthority("microsoft");
    const draft = await configureNativeBrowserOAuthConnector(
      oauthDraft("microsoft"),
    );
    await beginNativeBrowserAuthorization(draft.connectionId);
    const signed = await microsoftAssertion(
      oauthPending(draft.connectionId).state,
      override,
    );
    provider.replies.push(
      {
        body: {
          access_token: "rejected-ms-access",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid User.Read",
          id_token: signed.token,
        },
      },
      { body: signed.jwks },
      { body: { id: microsoftAccount, displayName: "Account" } },
      { body: { id: microsoftAccount, displayName: "Account" } },
    );
    await expect(
      finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
    ).rejects.toThrow();
    expect(readNativeConnector(draft.connectionId)?.status).toBe("cleanup");
    expect(
      loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery[0]
        ?.grant?.accessToken,
    ).toBe("rejected-ms-access");
    expect(readNativeConnector(draft.connectionId)?.identity).toBeNull();
  },
);
