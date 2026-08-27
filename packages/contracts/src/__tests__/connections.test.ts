import { describe, expect, it } from "vitest";
import {
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  BindingSchema,
  ConnectionErrorCodeSchema,
  ConnectionEventSchema,
  ConnectionSchema,
  ConnectionStatusSchema,
  CreateBindingRequestSchema,
  CreateConnectionRequestSchema,
  CreateIntegrationRequestSchema,
  DiscoverConnectionsResponseSchema,
  EgressSchema,
  IntegrationSchema,
  ListConnectionsResponseSchema,
  ListEventsResponseSchema,
  ListIntegrationsResponseSchema,
  ListProvidersResponseSchema,
  ProviderSchema,
  RevokeResponseSchema,
  ScopeDefSchema,
  SetCredentialRequestSchema,
  UpdateConnectionPolicyRequestSchema,
  UpdateIntegrationRequestSchema,
} from "../index.js";

const egress = {
  scheme: "https",
  authorities: ["api.github.com"],
  path_prefixes: [],
};

const provider = {
  id: "github",
  display_name: "GitHub",
  category: "developer",
  docs_url: "https://docs.github.com/apps/oauth-apps",
  provenance_url: "https://docs.github.com/apps/oauth-apps",
  catalog_revision: "2026-08-10.1",
  auth_kind: "oauth2_authorization_code",
  supports_refresh: true,
  configured: false,
  callback_url: "https://host.test/api/v1/oauth/callback/github",
  missing_config: ["OPENSESAME_PROVIDER_GITHUB_CLIENT_ID"],
  scopes: [
    {
      name: "repo",
      description: "Full control of private repositories",
      sensitive: true,
      default: false,
    },
  ],
  egress,
  operations: ["repository.read", "pull_request.create"],
  integration_configuration_fields: [
    { name: "client_id", secret: false, required: true },
    { name: "client_secret", secret: true, required: true },
  ],
  connection_configuration_fields: [],
};

const binding = {
  id: "binding_01J",
  target_kind: "project",
  target_id: "project_01J",
  target_label: "acme/web",
  created_at: "2026-08-08T10:00:00.000Z",
};

const connection = {
  connection_id: "connection_01J",
  integration_id: "integration_01J",
  connection_ref: "conn://acme/web/github/main",
  logical_name: "github/main",
  display_name: "GitHub — acme",
  provider_id: "github",
  status: "pending",
  status_detail: null,
  organization_id: "organization_01J",
  project_id: null,
  owner_kind: "organization",
  shareability: "private",
  materialization: "deny",
  requested_scopes: ["repo"],
  granted_scopes: [],
  account_label: null,
  expires_at: null,
  refreshable: false,
  configured_fields: [],
  last_refreshed_at: null,
  max_invoke_level: 2,
  egress,
  bindings: [binding],
  created_at: "2026-08-08T10:00:00+00:00",
  updated_at: "2026-08-08T10:00:00+00:00",
};

const event = {
  id: "event_01J",
  kind: "authorize_started",
  at: "2026-08-08T10:00:01.000Z",
  detail: null,
};

const integration = {
  id: "integration_01J",
  key: "engineering",
  provider_id: "github",
  display_name: "Engineering GitHub",
  source: "organization",
  enabled: true,
  configured: true,
  callback_url: "https://host.test/api/v1/oauth/callback/github",
  scopes: ["read:user"],
  client_id_hint: "***1234",
  has_client_secret: true,
  configured_fields: [
    { name: "client_id", hint: "***1234" },
    { name: "client_secret", hint: "configured" },
  ],
  connection_count: 0,
  created_by: "principal:admin",
  created_at: "2026-08-08T10:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
};

describe("connection broker contracts", () => {
  it("keeps Host discovery responses bounded and strict", () => {
    expect(DiscoverConnectionsResponseSchema.parse({ configured: 2 })).toEqual({
      configured: 2,
    });
    expect(() =>
      DiscoverConnectionsResponseSchema.parse({
        configured: 1,
        api_key: "leak",
      }),
    ).toThrow();
  });

  it("parses the catalog payloads", () => {
    expect(EgressSchema.parse(egress).authorities).toEqual(["api.github.com"]);
    expect(ScopeDefSchema.parse(provider.scopes[0]).sensitive).toBe(true);
    expect(ProviderSchema.parse(provider).configured).toBe(false);
    expect(
      ListProvidersResponseSchema.parse({ providers: [provider] }).providers,
    ).toHaveLength(1);
  });

  it("parses connections, bindings and events", () => {
    expect(BindingSchema.parse(binding).target_kind).toBe("project");
    expect(ConnectionSchema.parse(connection).connection_ref).toBe(
      "conn://acme/web/github/main",
    );
    expect(ConnectionEventSchema.parse(event).kind).toBe("authorize_started");
    expect(
      ConnectionEventSchema.parse({ ...event, kind: "policy_updated" }).kind,
    ).toBe("policy_updated");
    expect(
      ListConnectionsResponseSchema.parse({ connections: [connection] })
        .connections[0]?.status,
    ).toBe("pending");
    expect(
      ListEventsResponseSchema.parse({ events: [event] }).events,
    ).toHaveLength(1);
  });

  it("parses request bodies", () => {
    expect(
      CreateConnectionRequestSchema.parse({
        integration_id: "integration_01J",
        provider_id: "github",
        scopes: ["repo"],
        shareability: "delegable",
      }).provider_id,
    ).toBe("github");
    expect(
      CreateConnectionRequestSchema.parse({ provider_id: "github" })
        .integration_id,
    ).toBeUndefined();
    expect(
      AuthorizeRequestSchema.parse({
        redirect_uri: "https://app.example.test/connections/return",
      }).redirect_uri,
    ).toBe("https://app.example.test/connections/return");
    expect(AuthorizeRequestSchema.parse({}).scopes).toBeUndefined();
    expect(SetCredentialRequestSchema.parse({ value: "key" }).value).toBe(
      "key",
    );
    expect(
      SetCredentialRequestSchema.parse({
        configuration_set: { api_key: "key" },
      }).configuration_set,
    ).toEqual({ api_key: "key" });
    expect(
      SetCredentialRequestSchema.parse({
        configuration_clear: ["api_key"],
      }).configuration_clear,
    ).toEqual(["api_key"]);
    expect(() => SetCredentialRequestSchema.parse({})).toThrow();
    expect(
      SetCredentialRequestSchema.parse({ value: "k".repeat(8 * 1024) }).value,
    ).toHaveLength(8 * 1024);
    expect(() =>
      SetCredentialRequestSchema.parse({ value: "k".repeat(8 * 1024 + 1) }),
    ).toThrow();
    expect(
      CreateBindingRequestSchema.parse({
        target_kind: "group",
        target_id: "group_01J",
      }).target_kind,
    ).toBe("group");
    expect(
      UpdateConnectionPolicyRequestSchema.parse({
        shareability: "organization_wide",
        max_invoke_level: 1,
      }).max_invoke_level,
    ).toBe(1);
    expect(() =>
      UpdateConnectionPolicyRequestSchema.parse({
        shareability: "private",
        max_invoke_level: 3,
      }),
    ).toThrow();
  });

  it("keeps integration credentials write-only", () => {
    expect(IntegrationSchema.parse(integration).source).toBe("organization");
    expect(
      ListIntegrationsResponseSchema.parse({ integrations: [integration] })
        .integrations,
    ).toHaveLength(1);
    expect(
      CreateIntegrationRequestSchema.parse({
        key: "engineering",
        provider_id: "github",
        display_name: "Engineering GitHub",
      }).scopes,
    ).toBeUndefined();
    expect(
      UpdateIntegrationRequestSchema.parse({ client_secret: "" }).client_secret,
    ).toBe("");
    expect(
      UpdateIntegrationRequestSchema.parse({
        configuration_set: { client_id: "new-client" },
        configuration_clear: ["client_secret"],
      }).configuration_clear,
    ).toEqual(["client_secret"]);
    expect(() =>
      UpdateIntegrationRequestSchema.parse({ provider_id: "github" }),
    ).toThrow();
    expect(() =>
      IntegrationSchema.parse({ ...integration, client_secret: "leak" }),
    ).toThrow();
  });

  it("parses authorize and revoke responses", () => {
    expect(
      AuthorizeResponseSchema.parse({
        authorization_url: "https://github.com/login/oauth/authorize?x=1",
        state: "state_01J",
        expires_at: "2026-08-08T10:10:00.000Z",
      }).state,
    ).toBe("state_01J");
    expect(
      RevokeResponseSchema.parse({ revoked: true, provider_revocation: "ok" })
        .provider_revocation,
    ).toBe("ok");
  });

  it("rejects any response carrying credential material (ADR 0032 §6)", () => {
    for (const leak of [
      { access_token: "at_live" },
      { refresh_token: "rt_live" },
      { client_secret: "cs_live" },
      { code_verifier: "cv_live" },
    ]) {
      expect(() =>
        ConnectionSchema.parse({ ...connection, ...leak }),
      ).toThrow();
    }
    expect(() =>
      ListConnectionsResponseSchema.parse({
        connections: [{ ...connection, access_token: "at_live" }],
      }),
    ).toThrow();
    expect(() =>
      AuthorizeResponseSchema.parse({
        authorization_url: "https://github.com/login/oauth/authorize",
        state: "state_01J",
        expires_at: "2026-08-08T10:10:00.000Z",
        code_verifier: "cv_live",
      }),
    ).toThrow();
    expect(() =>
      ProviderSchema.parse({ ...provider, client_secret: "cs_live" }),
    ).toThrow();
  });

  it("pins the status vocabulary", () => {
    expect(ConnectionStatusSchema.options).toEqual([
      "pending",
      "active",
      "needs_reauth",
      "expired",
      "revoked",
      "error",
    ]);
    expect(() => ConnectionStatusSchema.parse("connected")).toThrow();
    expect(() =>
      ConnectionSchema.parse({ ...connection, status: "failed" }),
    ).toThrow();
  });

  it("pins the error-code vocabulary", () => {
    for (const code of [
      "catalog_unavailable",
      "state_expired",
      "unsupported_credential",
      "invalid_request",
      "internal_error",
      "unauthorized",
      "forbidden",
    ]) {
      expect(ConnectionErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(() => ConnectionErrorCodeSchema.parse("boom")).toThrow();
    expect(() => ConnectionErrorCodeSchema.parse("provider_missing")).toThrow();
  });
});
