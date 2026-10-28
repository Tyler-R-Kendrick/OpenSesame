import { afterEach, expect, it } from "vitest";
import { connectPlan } from "./connect-plan.js";
import { readNativeConnector } from "./native-connector-store.js";
import { isGoogleDriveAccountScopeSet } from "./native-google-drive-account.js";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
} from "./native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "./native-oauth-client-exchange.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
import { createNativeOAuthResourceDriver } from "./native-oauth-resource-driver.js";
import { nativeOAuthScopeIncludes } from "./native-oauth-scope-equivalence.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";

const emailAlias = "https://www.googleapis.com/auth/userinfo.email";
const driveScope = "https://www.googleapis.com/auth/drive.readonly";
const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

async function account(requestedEmail: string, grantedScopes: string) {
  const fixture = await nativeOAuthClientFixture();
  closes.push(fixture.close);
  const oauth = connectPlan("google-drive")?.methods.find(
    (method) => method.kind === "oauth",
  );
  if (oauth?.kind !== "oauth" || !oauth.preset?.userinfoEndpoint)
    throw new Error("Expected the account-only OIDC contract");
  const preset = oauth.preset;
  const resource = preset.userinfoEndpoint;
  if (!resource) throw new Error("Expected the OIDC user-info endpoint");
  const input = {
    ...fixture.input,
    providerId: "google-drive",
    parameters: {
      ...fixture.input.parameters,
      issuer: preset.serverUrl,
      authorization_endpoint: preset.authorizationEndpoint,
      token_endpoint: preset.tokenEndpoint,
      resource,
    },
    requestedScopes: { user: ["openid", requestedEmail] },
  };
  const saved = await configureNativeOAuthClient(input, fixture.owner);
  const authorization = new URL(
    await beginNativeOAuthClient(saved.connectionId, fixture.owner),
  );
  const callback = new URLSearchParams({
    native_state: authorization.searchParams.get("state") ?? "",
    native_code: "one-use-code",
  }).toString();
  const calls: string[] = [];
  const reply = async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(requestInput, init);
    calls.push(request.url);
    if (request.url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "synthetic-account-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: grantedScopes,
      });
    if (request.url === "https://www.googleapis.com/oauth2/v3/userinfo")
      return Response.json({
        sub: "synthetic-account",
        email: "a@example.test",
      });
    throw new Error("Unexpected provider request");
  };
  fixture.owner.transport.fetch = reply;
  fixture.owner.transport.settleCredentialMutation = reply;
  return { fixture, saved, callback, calls };
}

it.each([
  ["email", emailAlias],
  [emailAlias, "email"],
] as const)(
  "accepts equivalent account scopes requested as %s and granted as %s",
  async (requestedEmail, grantedEmail) => {
    const { fixture, saved, callback, calls } = await account(
      requestedEmail,
      `openid ${grantedEmail}`,
    );
    await exchangeNativeOAuthClient(callback, fixture.owner);
    const driver = createNativeOAuthResourceDriver({
      supports: (id) => id === "google-drive",
      capture: () => ({ ...fixture.owner, close: () => {} }),
    });
    await driver.verify(saved.connectionId);
    const connected = readNativeConnector(saved.connectionId);
    expect(connected?.status).toBe("connected");
    expect(connected?.grants[0]?.grantedScopes).toEqual([
      "openid",
      grantedEmail,
    ]);
    expect(calls).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/oauth2/v3/userinfo",
    ]);
  },
);

it("retains an overbroad grant for cleanup and never uses it", async () => {
  const { fixture, saved, callback, calls } = await account(
    "email",
    `openid ${emailAlias} ${driveScope}`,
  );
  await expect(
    exchangeNativeOAuthClient(callback, fixture.owner),
  ).rejects.toThrow();
  expect(calls).toEqual(["https://oauth2.googleapis.com/token"]);
  const record = requireNativeOAuthRecord(saved.connectionId);
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
  expect(record.privateState.grants).toEqual({});
  expect(
    record.privateState.recovery.some(
      (entry) =>
        entry.credentials?.protocol_valid === "false" &&
        entry.grant?.scopes === null,
    ),
  ).toBe(true);
});

it("accepts only the exact Google account aliases and keeps other providers literal", () => {
  expect(
    isGoogleDriveAccountScopeSet("google-drive", [
      "openid",
      "email",
      emailAlias,
    ]),
  ).toBe(true);
  for (const scope of [
    `${emailAlias}/`,
    `${emailAlias}?scope=drive`,
    driveScope,
  ]) {
    expect(
      isGoogleDriveAccountScopeSet("google-drive", ["openid", scope]),
    ).toBe(false);
  }
  expect(
    nativeOAuthScopeIncludes("other-provider", [emailAlias], "email"),
  ).toBe(false);
  expect(
    nativeOAuthScopeIncludes("other-provider", ["email"], emailAlias),
  ).toBe(false);
  expect(
    nativeOAuthScopeIncludes("other-provider", [emailAlias], emailAlias),
  ).toBe(true);
});
