import { describe, expect, it } from "vitest";
import {
  chooseOrganization,
  parseConnectionList,
  parseIntegrationList,
  parseMemberList,
  parseProviderList,
} from "./connections.js";

describe("connections wire parsers", () => {
  it("keeps the provider catalog searchable without inventing entries", () => {
    expect(
      parseProviderList({
        providers: [
          {
            id: "github",
            display_name: "GitHub",
            category: "developer",
            docs_url: "https://docs.github.com/apps/oauth-apps",
            auth_kind: "oauth2_authorization_code",
            callback_url:
              "https://host.example/api/v1/connections/oauth/callback",
            scopes: [
              {
                name: "read:user",
                description: "Read profile",
                sensitive: false,
                default: true,
              },
            ],
          },
          { display_name: "missing id" },
          {
            id: "mystery",
            display_name: "Mystery",
            category: "developer",
            auth_kind: "paste_secret_somewhere",
          },
          {
            id: "odd-category",
            display_name: "Odd category",
            category: "misc",
            auth_kind: "api_key",
          },
        ],
      }),
    ).toEqual([
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

  it("maps only the safe integration shape and never returns secret bytes", () => {
    const [integration] = parseIntegrationList({
      integrations: [
        {
          id: "int_1",
          key: "github-primary",
          provider_id: "github",
          display_name: "GitHub primary",
          source: "organization",
          enabled: true,
          configured: true,
          scopes: ["read:user"],
          client_id_hint: "gho_…4d2",
          has_client_secret: true,
          client_secret: "must-not-cross",
          connection_count: 2,
          callback_url:
            "https://host.example/api/v1/connections/oauth/callback",
        },
      ],
    });

    expect(integration).toEqual({
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
    expect(JSON.stringify(integration)).not.toContain("must-not-cross");
    expect(
      parseIntegrationList({
        integrations: [
          {
            id: "int_unknown",
            provider_id: "github",
            source: "mystery",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps legacy connections without integrations and validates roles", () => {
    expect(
      parseConnectionList({
        connections: [
          {
            connection_id: "conn_1",
            integration_id: "int_1",
            provider_id: "github",
            display_name: "Work GitHub",
            status: "active",
            refreshable: true,
            granted_scopes: ["read:user"],
          },
          {
            connection_id: "legacy",
            integration_id: null,
            provider_id: "github",
            display_name: "Legacy GitHub",
          },
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
    expect(
      parseConnectionList({
        connections: [
          {
            connection_id: "conn_1",
            integration_id: "int_1",
            refreshable: true,
          },
        ],
      })[0]?.refreshable,
    ).toBe(true);
    expect(
      parseMemberList({
        members: [
          { principalId: "prn_owner", organizationId: "org_1", role: "owner" },
          {
            principalId: "prn_bad",
            organizationId: "org_1",
            role: "superuser",
          },
        ],
      }),
    ).toEqual([{ principalId: "prn_owner", role: "owner" }]);
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
