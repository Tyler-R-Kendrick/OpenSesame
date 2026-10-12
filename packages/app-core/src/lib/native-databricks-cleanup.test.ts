import { expect, it } from "vitest";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
} from "./native-browser-oauth-connectors.js";
import type { NativeCleanupContext } from "./native-connector-lifecycle.js";
import type { NativeRecovery } from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { cleanupNativeDatabricksAuthorization } from "./native-databricks-cleanup.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
} from "./native-oauth.test-support.js";
installNativeOAuthTests();
async function setup() {
  const provider = oauthAuthority("databricks");
  const input = oauthDraft("databricks");
  input.parameters.domain = "dbc-own-workspace.cloud.databricks.com";
  input.parameters.integration_id = "registered-app-123";
  const draft = await configureNativeBrowserOAuthConnector(input);
  const record = loadNativeConnectorRecord(draft.connectionId);
  if (!record) throw new Error("Missing configured test connection");
  const context: NativeCleanupContext = {
    connectionId: draft.connectionId,
    configuration: record.configuration,
    persistGrantRotation: async () => undefined,
  };
  const entry: NativeRecovery = {
    id: "owned-grant",
    kind: "revoke",
    providerId: "databricks",
    actor: "user",
    fingerprint: record.configuration.fingerprint,
    targetId: "databricks",
    credentials: { integration_id: "registered-app-123" },
    grant: {
      kind: "oauth",
      providerId: "databricks",
      actor: "user",
      fingerprint: record.configuration.fingerprint,
      targetId: "databricks",
      issuer: "https://dbc-own-workspace.cloud.databricks.com/oidc",
      endpoint: "https://dbc-own-workspace.cloud.databricks.com/oidc/v1/token",
      clientId: "public-browser-client",
      accessToken: "still-valid-issued-access",
      refreshToken: "still-valid-issued-refresh",
      expiresAt: Date.now() + 3600000,
      scopes: ["all-apis"],
    },
  };
  return { provider, draft, context, entry };
}
it("calls the documented app-consent DELETE while truthfully reporting remaining tokens only locally forgotten", async () => {
  const { provider, context, entry } = await setup();
  provider.replies.push({ body: {} });
  expect(
    await cleanupNativeDatabricksAuthorization(
      entry,
      context,
      provider.transport,
    ),
  ).toBe("local-credential-forgotten");
  expect(String(provider.fetch.mock.calls[0]?.[0])).toBe(
    "https://dbc-own-workspace.cloud.databricks.com/api/2.0/oauth-app-integrations/registered-app-123/user-consent/me",
  );
  expect(provider.fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
  expect(
    new Headers(provider.fetch.mock.calls[0]?.[1]?.headers).get(
      "authorization",
    ),
  ).toBe("Bearer still-valid-issued-access");
  expect(JSON.stringify(provider.fetch.mock.calls)).not.toContain(
    "still-valid-issued-refresh",
  );
});
it("refuses a consent mutation against a workspace different from the immutable grant", async () => {
  const { provider, context, entry } = await setup();
  context.configuration.parameters.domain = "dbc-another.cloud.databricks.com";
  await expect(
    cleanupNativeDatabricksAuthorization(entry, context, provider.transport),
  ).rejects.toThrow();
  expect(provider.fetch).not.toHaveBeenCalled();
});
it("does not mark consent revoked when the documented endpoint fails", async () => {
  const { provider, context, entry } = await setup();
  provider.replies.push({ body: { error: "refused" }, status: 403 });
  await expect(
    cleanupNativeDatabricksAuthorization(entry, context, provider.transport),
  ).rejects.toThrow();
});
it("records a lost token reply as an unobserved authorization outcome with no fake grant or endless revocation request", async () => {
  const { provider, draft } = await setup();
  await beginNativeBrowserAuthorization(draft.connectionId);
  await expect(
    finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
  ).rejects.toThrow();
  const current = loadNativeConnectorRecord(draft.connectionId);
  const entry = current?.privateState.recovery[0];
  if (!current || !entry) throw new Error("Missing retained exchange outcome");
  expect(entry.grant).toBeUndefined();
  expect(entry.kind).toBe("revoke");
  expect(entry.credentials?.phase).toBe("exchange-unobserved");
  expect(
    readNativeConnector(draft.connectionId)?.configuration.parameters
      .authorization_outcome,
  ).toBe("exchange-unobserved");
  expect(
    await cleanupNativeDatabricksAuthorization(
      entry,
      {
        connectionId: draft.connectionId,
        configuration: current.configuration,
        persistGrantRotation: async () => undefined,
      },
      provider.transport,
    ),
  ).toBe("local-credential-forgotten");
});
it("never clears an exchange that may still be in flight", async () => {
  const { provider, context, entry } = await setup();
  entry.grant = undefined;
  entry.credentials = {
    phase: "exchange",
    deadline: String(Date.now() + 60000),
  };
  await expect(
    cleanupNativeDatabricksAuthorization(entry, context, provider.transport),
  ).rejects.toThrow();
  expect(provider.fetch).not.toHaveBeenCalled();
});
