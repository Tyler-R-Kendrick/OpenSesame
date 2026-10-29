import { afterEach, describe, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
  nativeOAuthClientClassification,
  readNativeOAuthClientSecret,
} from "./native-oauth-client-config.js";
import {
  exchangeNativeOAuthClient,
  issued,
} from "./native-oauth-client-exchange.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  nativeOAuthClientFixture,
} from "./native-oauth-client.test-support.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import { vaultStore } from "./vault/store.js";

const closing: (() => Promise<void>)[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  await Promise.allSettled(pending.splice(0));
});
async function setup(
  method: Parameters<typeof nativeOAuthClientFixture>[0] = "none",
  scopes?: readonly string[],
  resourceParameter?: "send" | "omit",
) {
  const fixture = await nativeOAuthClientFixture(method);
  closing.push(fixture.close);
  if (scopes) fixture.input.requestedScopes.user = [...scopes];
  if (resourceParameter) {
    fixture.state.resourceParameter = resourceParameter;
    fixture.input.parameters.resource_parameter = resourceParameter;
  }
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
  return { ...fixture, saved, authorization, search };
}

describe("shared native OAuth client configuration, real vault custody and HTTPS code exchange", () => {
  it.each(["none", "client_secret_basic", "client_secret_post"] as const)(
    "exchanges actual S256 %s authorization and retains the issued grant for real operation verification",
    async (method) => {
      const f = await setup(method);
      expect(f.authorization.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(f.authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(f.authorization.href).not.toContain(
        encodeURIComponent(CLIENT_SECRET),
      );
      expect(JSON.stringify(readDeviceRows())).not.toContain(CLIENT_SECRET);
      expect(
        JSON.stringify(
          requireNativeOAuthRecord(f.saved.connectionId).privateState
            .credentials,
        ),
      ).not.toContain(CLIENT_SECRET);
      expect(readNativeOAuthClientSecret(f.saved.connectionId, f.owner)).toBe(
        method === "none" ? undefined : CLIENT_SECRET,
      );
      if (method !== "none")
        expect(vaultStore.getSnapshot().items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "credential",
              method: expect.objectContaining({
                type: "token",
                token: CLIENT_SECRET,
              }),
            }),
          ]),
        );
      const result = await exchangeNativeOAuthClient(f.search, f.owner);
      const record = requireNativeOAuthRecord(result.connectionId);
      expect(record.privateState.pending).toEqual({});
      expect(record.privateState.grants).toEqual({});
      expect(record.runtime.verifiedAt).toBeNull();
      expect(readNativeConnector(result.connectionId)?.status).toBe("cleanup");
      expect(record.privateState.recovery[0]).toMatchObject({
        id: result.intentId,
        credentials: { phase: "verify", protocol_valid: "true" },
        grant: {
          issuer: f.input.parameters.issuer,
          endpoint: f.input.parameters.token_endpoint,
          resource: f.state.resource,
          clientId: CLIENT_ID,
          accessToken: "issued-access-1",
          refreshToken: "issued-refresh-1",
          scopes: ["read:items"],
        },
      });
      expect(f.requests).toHaveLength(1);
      await expect(
        exchangeNativeOAuthClient(f.search, f.owner),
      ).rejects.toThrow();
      expect(f.requests).toHaveLength(1);
    },
  );

  it("accepts refresh-token evidence when offline_access is absent from access-token scopes", async () => {
    const f = await setup(
      "client_secret_post",
      ["offline_access", "read:items"],
      "omit",
    );
    expect(f.authorization.searchParams.get("scope")?.split(" ")).toContain(
      "offline_access",
    );
    expect(f.authorization.searchParams.has("resource")).toBe(false);
    const result = await exchangeNativeOAuthClient(f.search, f.owner);
    expect(new URLSearchParams(f.requests[0]?.body).has("resource")).toBe(
      false,
    );
    expect(
      requireNativeOAuthRecord(result.connectionId).privateState.recovery[0]
        ?.grant,
    ).toMatchObject({
      refreshToken: "issued-refresh-1",
      scopes: ["read:items"],
    });
  });

  it("retains an over-scoped Google token response as protocol-invalid", async () => {
    const f = await setup();
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
    const f = await setup();
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

  it("refuses wrong-client credentials without exposing provider secret text or claiming verification", async () => {
    const f = await setup("client_secret_basic");
    f.state.wrongClient = true;
    await expect(
      exchangeNativeOAuthClient(f.search, f.owner),
    ).rejects.not.toThrow(CLIENT_SECRET);
    expect(f.state.issued).toBe(0);
    expect(
      requireNativeOAuthRecord(f.saved.connectionId).privateState.recovery[0]
        ?.grant,
    ).toBeUndefined();
    expect(readNativeConnector(f.saved.connectionId)?.status).toBe(
      "configuration",
    );
  });
  it("rejects a pending token destination changed after consent before any egress", async () => {
    const f = await setup();
    const record = requireNativeOAuthRecord(f.saved.connectionId);
    await updateNativeConnector(
      record.connectionId,
      nativeOAuthGuard(record),
      nativeOAuthClientClassification(),
      (current) => {
        const p = current.privateState.pending.user;
        if (!p) throw new Error("Missing pending");
        p.endpoint = `${f.input.parameters.token_endpoint}/other`;
        return current;
      },
    );
    await expect(
      exchangeNativeOAuthClient(f.search, f.owner),
    ).rejects.toMatchObject({ code: "expired" });
    expect(f.requests).toHaveLength(0);
  });
  it("refuses actual vault Token edits before sending the captured client credential", async () => {
    const f = await setup("client_secret_post");
    const item = vaultStore
      .getSnapshot()
      .items.find((item) => item.kind === "credential");
    if (!item || item.kind !== "credential" || item.method.type !== "token")
      throw new Error("Missing client secret Token");
    await vaultStore.saveItem({
      ...item,
      method: { ...item.method, token: "rotated-secret" },
    });
    await expect(
      exchangeNativeOAuthClient(f.search, f.owner),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
  it("withdraws the original owner without adopting a new ambient activation", async () => {
    const f = await setup();
    f.controller.abort();
    await expect(
      exchangeNativeOAuthClient(f.search, f.owner),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
  it("journals a genuinely issued held token after owner withdrawal without activating it", async () => {
    const f = await setup("client_secret_basic");
    f.state.hold = true;
    const operation = exchangeNativeOAuthClient(f.search, f.owner);
    pending.push(operation);
    const assertion = expect(operation).rejects.toThrow();
    await f.entered.promise;
    f.controller.abort();
    f.release.resolve();
    await assertion;
    const record = requireNativeOAuthRecord(f.saved.connectionId);
    expect(f.state.issued).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.recovery[0]?.grant?.accessToken).toBe(
      "issued-access-1",
    );
  });
  it("retains an issued token against the original target when configuration changes in flight", async () => {
    const f = await setup("client_secret_post");
    f.state.hold = true;
    const operation = exchangeNativeOAuthClient(f.search, f.owner);
    pending.push(operation);
    const assertion = expect(operation).rejects.toMatchObject({
      code: "expired",
    });
    await f.entered.promise;
    const record = requireNativeOAuthRecord(f.saved.connectionId);
    await updateNativeConnector(
      record.connectionId,
      nativeOAuthGuard(record),
      nativeOAuthClientClassification(),
      (current) => {
        current.configuration.parameters.token_endpoint = `${f.input.parameters.token_endpoint}/new`;
        current.configuration.fingerprint = "a".repeat(64);
        return current;
      },
    );
    f.release.resolve();
    await assertion;
    const current = requireNativeOAuthRecord(record.connectionId);
    expect(current.privateState.grants).toEqual({});
    expect(current.privateState.recovery[0]?.grant).toMatchObject({
      fingerprint: record.configuration.fingerprint,
      endpoint: f.input.parameters.token_endpoint,
      accessToken: "issued-access-1",
    });
    expect(f.requests).toHaveLength(1);
  });
  it("retains malformed token details and missing selected permissions without activating", async () => {
    const f = await setup();
    f.state.invalidDetails = true;
    await expect(
      exchangeNativeOAuthClient(f.search, f.owner),
    ).rejects.toMatchObject({ code: "provider" });
    const record = requireNativeOAuthRecord(f.saved.connectionId);
    expect(record.privateState.recovery[0]).toMatchObject({
      credentials: { protocol_valid: "false" },
      grant: { accessToken: "issued-access-1" },
    });
    expect(record.privateState.grants).toEqual({});
  });
  it("requires selected permission evidence when the token endpoint returns scopes", async () => {
    const f = await setup();
    f.state.scope = "different:scope";
    await expect(
      exchangeNativeOAuthClient(f.search, f.owner),
    ).rejects.toMatchObject({ code: "scope" });
    expect(
      requireNativeOAuthRecord(f.saved.connectionId).privateState.grants,
    ).toEqual({});
  });
  it("preserves the exact revision/CAS and refuses configuration edits with a pending authorization", async () => {
    const f = await setup("client_secret_post");
    await expect(
      configureNativeOAuthClient(
        {
          ...f.input,
          connectionId: f.saved.connectionId,
          revision: f.saved.revision,
        },
        f.owner,
      ),
    ).rejects.toMatchObject({ code: "expired" });
    const record = loadNativeConnectorRecord(f.saved.connectionId);
    if (!record) throw new Error("Missing record");
    await expect(
      configureNativeOAuthClient(
        {
          ...f.input,
          connectionId: record.connectionId,
          revision: record.revision,
        },
        f.owner,
      ),
    ).rejects.toMatchObject({ code: "cleanup" });
    expect(f.requests).toHaveLength(0);
  });
  it("refuses secretless PKCE use after the actual owning vault locks", async () => {
    const f = await setup();
    vaultStore.lock();
    await expect(
      exchangeNativeOAuthClient(f.search, f.owner),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
  it.each([
    "plain-http",
    "userinfo",
    "public-secret",
    "secret-on-public-client",
  ])(
    "rejects %s configuration before credentials or requests are admitted",
    async (invalid) => {
      const f = await nativeOAuthClientFixture();
      closing.push(f.close);
      if (invalid === "plain-http")
        f.input.parameters.token_endpoint =
          f.input.parameters.token_endpoint?.replace("https:", "http:") ?? "";
      if (invalid === "userinfo")
        f.input.parameters.issuer = "https://name:secret@issuer.example/";
      if (invalid === "public-secret")
        f.input.parameters.client_secret = CLIENT_SECRET;
      if (invalid === "secret-on-public-client")
        f.input.credentials.client_secret = CLIENT_SECRET;
      await expect(
        configureNativeOAuthClient(f.input, f.owner),
      ).rejects.toThrow();
      expect(readDeviceRows()).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
    },
  );
  it("saves a form's blank token relay as absent and exchanges at the token endpoint", async () => {
    const fixture = await nativeOAuthClientFixture("client_secret_post");
    closing.push(fixture.close);
    const saved = await configureNativeOAuthClient(
      {
        ...fixture.input,
        parameters: { ...fixture.input.parameters, token_relay_url: "" },
      },
      fixture.owner,
    );
    expect(
      loadNativeConnectorRecord(saved.connectionId)?.configuration.parameters,
    ).not.toHaveProperty("token_relay_url");
    const authorization = new URL(
      await beginNativeOAuthClient(saved.connectionId, fixture.owner),
    );
    fixture.state.challenge =
      authorization.searchParams.get("code_challenge") ?? "";
    await exchangeNativeOAuthClient(
      new URLSearchParams({
        native_state: authorization.searchParams.get("state") ?? "",
        native_code: "one-use-code",
      }).toString(),
      fixture.owner,
    );
    expect(fixture.requests.map((row) => row.path)).toEqual(["/token"]);
  });
  it("accepts a standards-compliant bearer without optional expiry while retaining it for resource verification", async () => {
    const f = await setup();
    f.state.noExpiry = true;
    const receipt = await exchangeNativeOAuthClient(f.search, f.owner);
    expect(
      requireNativeOAuthRecord(receipt.connectionId).privateState.recovery[0]
        ?.grant,
    ).toMatchObject({ expiresAt: null, accessToken: "issued-access-1" });
    expect(
      requireNativeOAuthRecord(receipt.connectionId).privateState.grants,
    ).toEqual({});
  });
});
