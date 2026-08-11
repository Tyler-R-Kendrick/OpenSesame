import { describe, expect, it } from "vitest";
import {
  chooseOrganization,
  parseConnectionList,
  parseIntegrationList,
  parseMemberList,
  parseProviderList,
} from "./connections.js";

const timestamp = "2026-08-10T18:00:00Z";
const egress = {
  scheme: "https",
  authorities: ["api.example.test"],
  path_prefixes: ["/"],
};

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: "github",
    display_name: "GitHub",
    category: "developer",
    docs_url: "https://docs.github.com/apps/oauth-apps",
    auth_kind: "oauth2_authorization_code",
    supports_refresh: true,
    configured: true,
    callback_url: "https://host.example/api/v1/connections/oauth/callback",
    missing_config: [],
    scopes: [
      {
        name: "read:user",
        description: "Read profile",
        sensitive: false,
        default: true,
      },
    ],
    egress,
    operations: ["profile.read"],
    ...overrides,
  };
}

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: "int_1",
    key: "github-primary",
    provider_id: "github",
    display_name: "GitHub primary",
    source: "organization",
    enabled: true,
    configured: true,
    callback_url: "https://host.example/api/v1/connections/oauth/callback",
    scopes: ["read:user"],
    client_id_hint: "gho_…4d2",
    has_client_secret: true,
    connection_count: 2,
    created_by: "principal:owner",
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    connection_id: "conn_1",
    integration_id: "int_1",
    connection_ref: "conn://github/work",
    logical_name: "work",
    display_name: "Work GitHub",
    provider_id: "github",
    status: "active",
    status_detail: null,
    organization_id: "org_1",
    project_id: null,
    owner_kind: "principal",
    shareability: "private",
    requested_scopes: ["read:user"],
    granted_scopes: ["read:user"],
    account_label: null,
    expires_at: null,
    refreshable: true,
    last_refreshed_at: timestamp,
    max_invoke_level: 1,
    egress,
    bindings: [],
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function member(overrides: Record<string, unknown> = {}) {
  return {
    principalId: "prn_owner",
    organizationId: "org_1",
    role: "owner",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("connections wire parsers", () => {
  it("maps a complete provider catalog response", () => {
    expect(parseProviderList({ providers: [provider()] })).toEqual([
      {
        id: "github",
        displayName: "GitHub",
        category: "developer",
        docsUrl: "https://docs.github.com/apps/oauth-apps",
        authKind: "oauth2_authorization_code",
        callbackUrl: "https://host.example/api/v1/connections/oauth/callback",
        scopes: [
          {
            name: "read:user",
            description: "Read profile",
            sensitive: false,
            default: true,
          },
        ],
      },
    ]);
  });

  it("rejects unknown integration fields instead of stripping secrets", () => {
    expect(parseIntegrationList({ integrations: [integration()] })[0]).toEqual({
      id: "int_1",
      key: "github-primary",
      providerId: "github",
      displayName: "GitHub primary",
      source: "organization",
      enabled: true,
      configured: true,
      scopes: ["read:user"],
      clientIdHint: "gho_…4d2",
      hasClientSecret: true,
      connectionCount: 2,
      callbackUrl: "https://host.example/api/v1/connections/oauth/callback",
    });
    expect(() =>
      parseIntegrationList({
        integrations: [integration({ client_secret: "must-not-cross" })],
      }),
    ).toThrow(/unrecognized_keys/iu);
    expect(() =>
      parseIntegrationList({
        integrations: [integration({ source: "mystery" })],
      }),
    ).toThrow();
  });

  it("keeps schema-valid legacy connections without integrations", () => {
    expect(
      parseConnectionList({
        connections: [
          connection(),
          connection({
            connection_id: "legacy",
            integration_id: null,
            connection_ref: "conn://github/legacy",
            logical_name: "legacy",
            display_name: "Legacy GitHub",
            status: "pending",
            granted_scopes: [],
            refreshable: false,
            last_refreshed_at: null,
          }),
        ],
      }),
    ).toEqual([
      expect.objectContaining({ id: "conn_1", integrationId: "int_1" }),
      expect.objectContaining({
        id: "legacy",
        integrationId: null,
        providerId: "github",
      }),
    ]);
  });

  it("rejects unknown fields at list and nested response boundaries", () => {
    expect(() =>
      parseProviderList({ providers: [provider()], access_token: "leak" }),
    ).toThrow(/unrecognized_keys/iu);
    expect(() =>
      parseProviderList({
        providers: [
          provider({
            scopes: [
              {
                name: "read:user",
                description: "Read profile",
                sensitive: false,
                default: true,
                refresh_token: "leak",
              },
            ],
          }),
        ],
      }),
    ).toThrow(/unrecognized_keys/iu);
    expect(() =>
      parseConnectionList({
        connections: [connection({ access_token: "leak" })],
      }),
    ).toThrow(/unrecognized_keys/iu);
    expect(() =>
      parseMemberList({ members: [member()], token: "leak" }),
    ).toThrow("Invalid members response");
    expect(() =>
      parseMemberList({ members: [member({ accessToken: "leak" })] }),
    ).toThrow(/unrecognized_keys/iu);
  });

  it("maps canonical memberships and rejects unknown roles", () => {
    expect(parseMemberList({ members: [member()] })).toEqual([
      { principalId: "prn_owner", role: "owner" },
    ]);
    expect(() =>
      parseMemberList({ members: [member({ role: "superuser" })] }),
    ).toThrow();
  });

  it("auto-selects only a sole organization and preserves a valid choice", () => {
    const one = [{ id: "org_1", displayName: "Acme", role: "owner" }] as const;
    expect(chooseOrganization([...one], null)).toBe("org_1");
    const two = [
      ...one,
      { id: "org_2", displayName: "Labs", role: "member" as const },
    ];
    expect(chooseOrganization(two, null)).toBeNull();
    expect(chooseOrganization(two, "org_2")).toBe("org_2");
  });
});
