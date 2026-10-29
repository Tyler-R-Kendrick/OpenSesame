import { afterEach, expect, it } from "vitest";
import { updateNativeConnector } from "./native-connector-store.js";
import { GOOGLE_ACCOUNT_POLICY } from "./native-google-account-policy.generated.js";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
  nativeOAuthClientClassification,
} from "./native-oauth-client-config.js";
import {
  exchangeNativeOAuthClient,
  issued,
} from "./native-oauth-client-exchange.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
import { verifyNativeOAuthMcpResource } from "./native-oauth-mcp-operations.js";
import { verifyNativeOAuthResource } from "./native-oauth-resource.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";

const EMAIL_URL = "https://www.googleapis.com/auth/userinfo.email";
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

async function googleExchange(requested: string[], issued: string) {
  const fixture = await nativeOAuthClientFixture("none");
  closing.push(fixture.close);
  const localToken = fixture.input.parameters.token_endpoint;
  if (!localToken) throw new Error("Missing local token endpoint");
  const localFetch = fixture.owner.transport.fetch;
  const redirected: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== GOOGLE_ACCOUNT_POLICY.endpoints.token_endpoint)
      throw new Error("Unexpected provider endpoint");
    return localFetch(localToken, {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      signal: request.signal,
    });
  };
  fixture.owner.transport.fetch = redirected;
  fixture.owner.transport.settleCredentialMutation = redirected;
  fixture.input.providerId = "google-drive";
  fixture.input.parameters = {
    client_id: fixture.input.parameters.client_id ?? "",
    ...GOOGLE_ACCOUNT_POLICY.endpoints,
    token_auth_method: "none",
    resource_parameter: "omit",
  };
  fixture.input.requestedScopes.user = requested;
  fixture.state.resourceParameter = "omit";
  fixture.state.scope = issued;
  const saved = await configureNativeOAuthClient(fixture.input, fixture.owner);
  const authorization = new URL(
    await beginNativeOAuthClient(saved.connectionId, fixture.owner),
  );
  fixture.state.challenge =
    authorization.searchParams.get("code_challenge") ?? "";
  const search = new URLSearchParams({
    native_state: authorization.searchParams.get("state") ?? "",
    native_code: "one-use-code",
  }).toString();
  return { ...fixture, saved, search };
}

it.each<{ requested: string[]; issued: string }>([
  { requested: ["openid", EMAIL_URL], issued: `openid ${EMAIL_URL}` },
  { requested: ["openid", EMAIL_URL], issued: "openid email" },
  { requested: ["openid", "email"], issued: `openid ${EMAIL_URL}` },
])(
  "exchanges equivalent Google account scopes end to end",
  async ({ requested, issued }) => {
    const f = await googleExchange(requested, issued);
    const receipt = await exchangeNativeOAuthClient(f.search, f.owner);
    expect(f.requests).toHaveLength(1);
    expect(
      requireNativeOAuthRecord(receipt.connectionId).privateState.recovery[0]
        ?.grant?.scopes,
    ).toEqual(["openid", "email"]);
  },
);

it("rejects an over-scoped Google token after retaining its credentials", async () => {
  const f = await googleExchange(
    ["openid", EMAIL_URL],
    `openid ${EMAIL_URL} https://www.googleapis.com/auth/drive.readonly`,
  );
  await expect(
    exchangeNativeOAuthClient(f.search, f.owner),
  ).rejects.toMatchObject({
    code: "provider",
  });
  const record = requireNativeOAuthRecord(f.saved.connectionId);
  expect(record.privateState.recovery[0]).toMatchObject({
    credentials: { protocol_valid: "false" },
    grant: { accessToken: "issued-access-1" },
  });
});

it("rejects legacy over-scoped Google grants before resource or MCP requests", async () => {
  const f = await googleExchange(["openid", EMAIL_URL], `openid ${EMAIL_URL}`);
  const receipt = await exchangeNativeOAuthClient(f.search, f.owner);
  const record = requireNativeOAuthRecord(receipt.connectionId);
  await updateNativeConnector(
    receipt.connectionId,
    nativeOAuthGuard(record),
    nativeOAuthClientClassification(),
    (current) => {
      const grant = current.privateState.recovery[0]?.grant;
      if (!grant) throw new Error("Missing retained grant");
      grant.scopes = [
        "openid",
        "email",
        "https://www.googleapis.com/auth/drive.readonly",
      ];
      return current;
    },
  );
  await expect(
    verifyNativeOAuthResource(receipt.connectionId, f.owner),
  ).rejects.toMatchObject({ code: "scope" });
  await expect(
    verifyNativeOAuthMcpResource(receipt.connectionId, f.owner),
  ).rejects.toMatchObject({ code: "scope" });
  expect(f.requests).toHaveLength(1);
});

it("retains an over-scoped Google token response as protocol-invalid", async () => {
  const f = await googleExchange(["openid", "email"], "openid email");
  const pending = requireNativeOAuthRecord(f.saved.connectionId).privateState
    .pending.user;
  if (!pending) throw new Error("Missing pending");
  const receipt = issued(
    {
      access_token: "issued-access-1",
      refresh_token: "issued-refresh-1",
      token_type: "Bearer",
      scope: "openid email https://www.googleapis.com/auth/drive.readonly",
    },
    200,
    { ...pending, providerId: "google-drive" },
  );
  expect(receipt.valid).toBe(false);
  expect(receipt.grant).toMatchObject({
    accessToken: "issued-access-1",
    refreshToken: "issued-refresh-1",
  });
});

it("accepts Google's documented URL-form email scope without granting Drive access", async () => {
  const f = await googleExchange(["openid", "email"], "openid email");
  const pending = requireNativeOAuthRecord(f.saved.connectionId).privateState
    .pending.user;
  if (!pending) throw new Error("Missing pending");
  const receipt = issued(
    {
      access_token: "issued-access-1",
      refresh_token: "issued-refresh-1",
      token_type: "Bearer",
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
    },
    200,
    { ...pending, providerId: "google-drive", scopes: ["openid", "email"] },
  );
  expect(receipt.valid).toBe(true);
  expect(receipt.grant.scopes).toEqual(["openid", "email"]);
});
