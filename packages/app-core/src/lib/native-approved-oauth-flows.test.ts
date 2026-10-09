import { expect, it } from "vitest";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
  invokeNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
} from "./native-oauth.test-support.js";

installNativeOAuthTests();
it("Codeberg public PKCE connects, verifies, and reads real provider repositories without a client secret or invented scopes", async () => {
  const provider = oauthAuthority("codeberg");
  const draft = await configureNativeBrowserOAuthConnector(
    oauthDraft("codeberg"),
  );
  await beginNativeBrowserAuthorization(draft.connectionId);
  const consent = new URL(provider.navigate.mock.calls[0]?.[0] ?? "");
  expect(consent.origin + consent.pathname).toBe(
    "https://codeberg.org/login/oauth/authorize",
  );
  expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
  expect(consent.searchParams.get("scope")).toBe("");
  provider.replies.push(
    {
      body: {
        access_token: "private-issued-codeberg",
        refresh_token: "private-refresh-codeberg",
        expires_in: 3600,
        token_type: "Bearer",
      },
    },
    {
      body: {
        id: 37,
        login: "actual-codeberg-owner",
        full_name: "Codeberg owner",
      },
    },
  );
  const connected = await finishNativeBrowserAuthorization(
    oauthCallback(draft.connectionId),
  );
  expect(connected.status).toBe("connected");
  expect(connected.identity?.id).toBe("37");
  expect(connected.grants[0]?.permissionState).toBe("provider-managed");
  const form = new URLSearchParams(
    String(provider.fetch.mock.calls[0]?.[1]?.body),
  );
  expect(form.has("client_secret")).toBe(false);
  expect(form.get("client_id")).toBe("public-browser-client");
  provider.replies.push(
    { body: { id: 37, login: "actual-codeberg-owner" } },
    {
      body: [
        {
          id: 71,
          full_name: "owner/project",
          html_url: "https://codeberg.org/owner/project",
        },
      ],
    },
  );
  expect(
    (
      await invokeNativeBrowserOAuthConnector(
        draft.connectionId,
        "provider.repositories.read",
      )
    ).items,
  ).toEqual([
    {
      id: "71",
      label: "owner/project",
      url: "https://codeberg.org/owner/project",
    },
  ]);
});
it("Crowdin public PKCE accepts the documented scope-free response and verifies the actual granted user resource", async () => {
  const provider = oauthAuthority("crowdin");
  const draft = await configureNativeBrowserOAuthConnector(
    oauthDraft("crowdin"),
  );
  await beginNativeBrowserAuthorization(draft.connectionId);
  provider.replies.push(
    {
      body: {
        access_token: "private-issued-crowdin",
        refresh_token: "private-refresh-crowdin",
        expires_in: 7200,
        token_type: "bearer",
      },
    },
    {
      body: {
        data: { id: 29, username: "crowdin-owner", fullName: "Crowdin owner" },
      },
    },
  );
  const view = await finishNativeBrowserAuthorization(
    oauthCallback(draft.connectionId),
  );
  expect(view.status).toBe("connected");
  expect(view.identity?.id).toBe("29");
  expect(view.grants[0]?.permissionState).toBe("provider-managed");
  expect(String(provider.fetch.mock.calls[0]?.[0])).toBe(
    "https://accounts.crowdin.com/oauth/token",
  );
  expect(
    new URLSearchParams(String(provider.fetch.mock.calls[0]?.[1]?.body)).has(
      "client_secret",
    ),
  ).toBe(false);
});
it("Databricks public workspace client returns usable SCIM self access from the registered workspace", async () => {
  const provider = oauthAuthority("databricks");
  const input = oauthDraft("databricks");
  input.parameters.domain = "dbc-own-workspace.cloud.databricks.com";
  const draft = await configureNativeBrowserOAuthConnector(input);
  await beginNativeBrowserAuthorization(draft.connectionId);
  const consent = new URL(provider.navigate.mock.calls[0]?.[0] ?? "");
  expect(consent.origin + consent.pathname).toBe(
    "https://dbc-own-workspace.cloud.databricks.com/oidc/v1/authorize",
  );
  provider.replies.push(
    {
      body: {
        access_token: "private-issued-databricks",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "all-apis",
      },
    },
    { body: { id: "12673", userName: "owner@example.test", active: true } },
  );
  const view = await finishNativeBrowserAuthorization(
    oauthCallback(draft.connectionId),
  );
  expect(view.status).toBe("connected");
  expect(view.identity).toMatchObject({
    id: "12673",
    kind: "workspace-account",
  });
  expect(String(provider.fetch.mock.calls[1]?.[0])).toBe(
    "https://dbc-own-workspace.cloud.databricks.com/api/2.0/preview/scim/v2/Me",
  );
  expect(
    new URLSearchParams(String(provider.fetch.mock.calls[0]?.[1]?.body)).has(
      "client_secret",
    ),
  ).toBe(false);
});
