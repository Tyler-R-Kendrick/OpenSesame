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
  EgressSchema,
  ListConnectionsResponseSchema,
  ListEventsResponseSchema,
  ListProvidersResponseSchema,
  ProviderCategorySchema,
  ProviderSchema,
  RevokeResponseSchema,
  ScopeDefSchema,
  SetCredentialRequestSchema,
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
  auth_kind: "oauth2_authorization_code",
  supports_refresh: true,
  configured: false,
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
};

it("accepts the four Fnox provider categories", () => {
  for (const category of [
    "encryption",
    "cloud_secret_storage",
    "password_managers",
    "local_storage",
  ]) {
    expect(ProviderCategorySchema.parse(category)).toBe(category);
  }
});

const binding = {
  id: "binding_01J",
  target_kind: "project",
  target_id: "project_01J",
  target_label: "acme/web",
  created_at: "2026-08-08T10:00:00.000Z",
};

const connection = {
  connection_id: "connection_01J",
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
  requested_scopes: ["repo"],
  granted_scopes: [],
  account_label: null,
  expires_at: null,
  refreshable: false,
  last_refreshed_at: null,
  max_invoke_level: 2,
  egress,
  bindings: [binding],
  created_at: "2026-08-08T10:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
};

const event = {
  id: "event_01J",
  kind: "authorize_started",
  at: "2026-08-08T10:00:01.000Z",
  detail: null,
};

describe("connection broker contracts", () => {
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
        provider_id: "github",
        scopes: ["repo"],
        shareability: "delegable",
      }).provider_id,
    ).toBe("github");
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
      CreateBindingRequestSchema.parse({
        target_kind: "agent",
        target_id: "agent_01J",
      }).target_kind,
    ).toBe("agent");
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
    expect(ConnectionErrorCodeSchema.parse("state_expired")).toBe(
      "state_expired",
    );
    expect(() => ConnectionErrorCodeSchema.parse("boom")).toThrow();
    expect(() => ConnectionErrorCodeSchema.parse("provider_missing")).toThrow();
  });
});
