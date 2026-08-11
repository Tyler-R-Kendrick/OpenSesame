import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection, Integration, Provider } from "../lib/connections.js";
import {
  CONNECTION_POLL_MAX_ATTEMPTS,
  ConnectionsGate,
  ConnectionsPanel,
  IntegrationsPanel,
  MarketplacePanel,
  canSealProviderConfiguration,
  configurationClearFromFormData,
  configurationFromFormData,
  connectionRevocationNotice,
  filterProviders,
  integrationConfigurationNotice,
  loadCatalogBeforeWorkspace,
  loadOptionalMembers,
  marketplaceEmptyCopy,
  parseConnectionMessage,
  reconcileOrganization,
  recoverCreatedConnection,
  runConfirmedAction,
  shouldPollPendingConnections,
  takeSensitiveFormData,
} from "./ConnectionsPage.js";

const oauthProvider: Provider = {
  id: "github",
  displayName: "GitHub",
  category: "developer",
  docsUrl: "https://docs.github.com",
  provenanceUrl: "https://docs.github.com",
  catalogRevision: "2026-08-10.4",
  authKind: "oauth2_authorization_code",
  configured: false,
  missingConfig: [],
  callbackUrl: "https://host.example/api/v1/connections/oauth/callback",
  scopes: [],
  integrationConfigurationFields: [
    { name: "client_id", secret: false, required: true },
    { name: "client_secret", secret: true, required: true },
  ],
  connectionConfigurationFields: [],
};

const apiKeyProvider: Provider = {
  ...oauthProvider,
  id: "linear",
  displayName: "Linear",
  authKind: "api_key",
  callbackUrl: null,
  integrationConfigurationFields: [],
  connectionConfigurationFields: [
    { name: "api_key", secret: true, required: true },
  ],
};

function integration(
  providerId: string,
  source: Integration["source"] = "organization",
): Integration {
  return {
    id: `int_${providerId}`,
    key: `${providerId}-primary`,
    providerId,
    displayName: `${providerId} primary`,
    source,
    enabled: true,
    configured: true,
    scopes: [],
    clientIdHint: "client…1234",
    hasClientSecret: true,
    connectionCount: 1,
    callbackUrl:
      providerId === "github"
        ? "https://host.example/api/v1/connections/oauth/callback"
        : null,
    configuredFields:
      providerId === "github"
        ? [
            { name: "client_id", hint: "***1234" },
            { name: "client_secret", hint: "configured" },
          ]
        : [],
  };
}

const apiKeyConnection: Connection = {
  id: "conn_linear",
  integrationId: "int_linear",
  providerId: "linear",
  displayName: "Linear work",
  accountLabel: null,
  status: "active",
  scopes: [],
  refreshable: false,
  configuredFields: [{ name: "api_key", hint: "configured" }],
};

describe("Connections marketplace panels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clears a credential from its live form immediately after reading it", () => {
    const credential = { value: "raw-secret" };
    const form = {
      reset: vi.fn(() => {
        credential.value = "";
      }),
    } as unknown as HTMLFormElement;
    vi.stubGlobal(
      "FormData",
      class {
        readonly captured = credential.value;
        constructor(received: HTMLFormElement) {
          expect(received).toBe(form);
        }
        get(name: string) {
          return name === "credential" ? this.captured : null;
        }
      },
    );

    const data = takeSensitiveFormData(form);

    expect(data.get("credential")).toBe("raw-secret");
    expect(credential.value).toBe("");
    expect(form.reset).toHaveBeenCalledOnce();
  });

  it("exposes one retryable Pending row after second-step failure", async () => {
    const original = new Error("Provider authorization failed safely.");
    const pending = { id: "conn_pending", status: "pending" };
    const visible: (typeof pending)[] = [];
    let creates = 0;
    creates += 1;

    await expect(
      recoverCreatedConnection(
        async () => {
          throw original;
        },
        async () => {
          visible.splice(0, visible.length, pending);
          throw new Error("workspace refresh failed after exposing the row");
        },
      ),
    ).rejects.toBe(original);

    expect(creates).toBe(1);
    expect(visible).toEqual([pending]);
    await expect(
      recoverCreatedConnection(
        async () => "authorized",
        async () => {
          throw new Error("reload must not run after a successful retry");
        },
      ),
    ).resolves.toBe("authorized");
    expect(creates).toBe(1);
  });

  it("keeps the connector workspace when optional member loading fails", async () => {
    await expect(
      loadOptionalMembers("owner", async () => {
        throw new Error("Identity member list unavailable");
      }),
    ).resolves.toEqual({ members: [], failed: true });
  });

  it("commits a valid catalog before unrelated workspace loading fails", async () => {
    const visible: Provider[] = [];
    await expect(
      loadCatalogBeforeWorkspace(
        async () => [oauthProvider],
        (catalog) => visible.push(...catalog),
        async () => {
          throw new Error("connections unavailable");
        },
      ),
    ).rejects.toThrow("connections unavailable");
    expect(visible).toEqual([oauthProvider]);
  });

  it("never calls an unconfigured integration ready", () => {
    expect(
      integrationConfigurationNotice("GitHub", {
        ...integration("github"),
        configured: false,
      }),
    ).toContain("is not ready");
    expect(
      integrationConfigurationNotice("GitHub", integration("github")),
    ).toContain("ready for members");
  });

  it("requires native confirmation before terminal mutations", () => {
    const mutate = vi.fn();
    const decline = vi.fn(() => false);
    const accept = vi.fn(() => true);

    expect(runConfirmedAction("Revoke?", mutate, decline)).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(runConfirmedAction("Revoke?", mutate, accept)).toBe(true);
    expect(mutate).toHaveBeenCalledOnce();
  });

  it.each([
    ["ok", "revoked locally and at GitHub"],
    [
      "failed",
      "automatic provider revocation failed. The upstream grant may remain; revoke access in GitHub",
    ],
    [
      "unsupported",
      "does not support automatic revocation. The upstream grant may remain; revoke access in GitHub",
    ],
  ] as const)("reports the %s provider revocation outcome", (outcome, text) => {
    expect(
      connectionRevocationNotice("Work GitHub", "GitHub", {
        revoked: true,
        provider_revocation: outcome,
      }),
    ).toContain(text);
  });

  it("polls only pending connections within the bounded retry budget", () => {
    expect(shouldPollPendingConnections([{ status: "pending" }], 0)).toBe(true);
    expect(shouldPollPendingConnections([{ status: "active" }], 0)).toBe(false);
    expect(
      shouldPollPendingConnections(
        [{ status: "pending" }],
        CONNECTION_POLL_MAX_ATTEMPTS,
      ),
    ).toBe(false);
  });

  it("uses refreshed membership role and drops removed organization access", () => {
    expect(
      reconcileOrganization(
        [{ id: "org_1", displayName: "Acme", role: "member" }],
        "org_1",
      ).organization?.role,
    ).toBe("member");
    expect(reconcileOrganization([], "org_1")).toEqual({
      organizationId: null,
      organization: null,
    });
  });

  it("accepts connection callbacks only from the configured Host origin", () => {
    const callback = {
      data: { type: "opensesame:connection", status: "active" },
      origin: "https://host.example",
    } as MessageEvent;

    expect(parseConnectionMessage(callback, "https://host.example")).toEqual({
      status: "active",
      error: null,
      hint: null,
    });
    expect(parseConnectionMessage(callback, "https://attacker.example")).toBe(
      null,
    );
    expect(
      parseConnectionMessage(
        {
          data: {
            type: "opensesame:connection",
            error: "oauth_denied",
            hint: "Provider authorization was denied.",
          },
          origin: "https://host.example",
        } as MessageEvent,
        "https://host.example",
      ),
    ).toEqual({
      status: null,
      error: "oauth_denied",
      hint: "Provider authorization was denied.",
    });
    expect(
      parseConnectionMessage(
        {
          data: { type: "different:event", status: "active" },
          origin: "https://host.example",
        } as MessageEvent,
        "https://host.example",
      ),
    ).toBe(null);
  });

  it("branches member connection forms by provider auth kind", () => {
    const html = renderToStaticMarkup(
      <MarketplacePanel
        providers={[oauthProvider, apiKeyProvider]}
        integrations={[integration("github"), integration("linear")]}
        accessRole="member"
        busy={null}
        loading={false}
        loadIssue={null}
        onRetry={() => undefined}
        onConfigure={() => undefined}
        onConnect={() => undefined}
      />,
    );

    expect(html).toContain("Authorize account");
    expect(html).toContain("Seal credentials");
    expect(html).toContain('name="configuration.api_key"');
    expect(html).not.toContain("Configure integration");
  });

  it("shows OAuth configuration only for OAuth providers", () => {
    const oauth = renderToStaticMarkup(
      <MarketplacePanel
        providers={[oauthProvider]}
        integrations={[]}
        accessRole="admin"
        busy={null}
        loading={false}
        loadIssue={null}
        onRetry={() => undefined}
        onConfigure={() => undefined}
        onConnect={() => undefined}
      />,
    );
    const apiKey = renderToStaticMarkup(
      <MarketplacePanel
        providers={[apiKeyProvider]}
        integrations={[]}
        accessRole="admin"
        busy={null}
        loading={false}
        loadIssue={null}
        onRetry={() => undefined}
        onConfigure={() => undefined}
        onConnect={() => undefined}
      />,
    );

    expect(oauth).toContain("OAuth callback URL");
    expect(oauth).toContain("Client secret");
    expect(oauth).toContain('name="configuration.client_secret"');
    expect(apiKey).not.toContain("Client secret");
  });

  it("keeps deployment and development integrations read-only", () => {
    const html = renderToStaticMarkup(
      <IntegrationsPanel
        integrations={[
          integration("github", "deployment"),
          integration("linear", "shared_dev"),
        ]}
        providers={[oauthProvider, apiKeyProvider]}
        accessRole="owner"
        busy={null}
        onToggle={() => undefined}
        onConfiguration={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Development only");
    expect(html).toContain("deployment-managed integration is read-only");
    expect(html).not.toContain("Update configuration");
    expect(html).not.toContain("Delete integration");
  });

  it("maps only declared integration configuration fields and explicit clears", () => {
    const data = new FormData();
    data.set("configuration.client_id", "  client-1234  ");
    data.set("configuration.client_secret", " secret with spaces ");
    data.set("configuration.undeclared", "ignored");
    data.append("configuration_clear", "client_secret");

    expect(
      configurationFromFormData(
        data,
        oauthProvider.integrationConfigurationFields,
      ),
    ).toEqual({
      client_id: "client-1234",
      client_secret: " secret with spaces ",
    });
    expect(
      configurationClearFromFormData(
        data,
        oauthProvider.integrationConfigurationFields,
      ),
    ).toEqual(["client_secret"]);
  });

  it("maps a declared connection credential field without retaining extras", () => {
    const data = new FormData();
    data.set("configuration.api_key", "key-value");
    data.set("configuration.token", "ignored");

    expect(
      configurationFromFormData(
        data,
        apiKeyProvider.connectionConfigurationFields,
      ),
    ).toEqual({ api_key: "key-value" });
  });

  it("renders update and explicit clear controls for connection fields", () => {
    const html = renderToStaticMarkup(
      <ConnectionsPanel
        connections={[apiKeyConnection]}
        integrations={[integration("linear")]}
        providers={[apiKeyProvider]}
        busy={null}
        onRefresh={() => undefined}
        onReauthorize={() => undefined}
        onConfiguration={() => undefined}
        onRevoke={() => undefined}
      />,
    );

    expect(html).toContain("Update credentials");
    expect(html).toContain('name="configuration.api_key"');
    expect(html).toContain('name="configuration_clear"');
    expect(html).not.toContain("key-value");
  });

  it("filters the catalog by search, category, and authentication", () => {
    expect(
      filterProviders(
        [oauthProvider, apiKeyProvider],
        "lin",
        "developer",
        "api_key",
      ),
    ).toEqual([apiKeyProvider]);
    expect(
      filterProviders(
        [oauthProvider, apiKeyProvider],
        "github",
        "developer",
        "api_key",
      ),
    ).toEqual([]);
  });

  it("never presents pending, failed, or empty catalogs as zero search results", () => {
    const render = (
      providers: Provider[] | null,
      loading: boolean,
      loadIssue: { kind: "host" | "catalog"; message: string } | null,
    ) =>
      renderToStaticMarkup(
        <MarketplacePanel
          providers={providers}
          integrations={[]}
          accessRole="member"
          busy={null}
          loading={loading}
          loadIssue={loadIssue}
          onRetry={() => undefined}
          onConfigure={() => undefined}
          onConnect={() => undefined}
        />,
      );

    expect(render(null, true, null)).toContain("Loading provider catalog");
    expect(
      render(null, false, { kind: "host", message: "Host is down." }),
    ).toContain("Host unavailable");
    expect(
      render(null, false, {
        kind: "catalog",
        message: "Catalog contract failed.",
      }),
    ).toContain("Provider catalog unavailable");
    expect(render([], false, null)).toContain("Provider catalog is empty");
    for (const html of [
      render(null, true, null),
      render(null, false, { kind: "host", message: "Host is down." }),
      render([], false, null),
    ]) {
      expect(html).not.toContain("No matching connectors");
    }
  });

  it("distinguishes Identity, organization-selection, and no-search states", () => {
    const identity = renderToStaticMarkup(
      <ConnectionsGate
        loading={false}
        issue={{ kind: "identity", message: "Sign in again." }}
        hasOrganizations={false}
        onRetry={() => undefined}
      />,
    );
    const selection = renderToStaticMarkup(
      <ConnectionsGate
        loading={false}
        issue={null}
        hasOrganizations
        onRetry={() => undefined}
      />,
    );

    expect(identity).toContain("Identity access required");
    expect(identity).toContain("Retry Identity");
    expect(selection).toContain("Choose an organization");
    expect(marketplaceEmptyCopy(true)).toEqual(
      expect.objectContaining({ title: "No matching connectors" }),
    );
  });

  it("shows the total and all three catalog filters", () => {
    const html = renderToStaticMarkup(
      <MarketplacePanel
        providers={[oauthProvider, apiKeyProvider]}
        integrations={[]}
        accessRole="member"
        busy={null}
        loading={false}
        loadIssue={null}
        onRetry={() => undefined}
        onConfigure={() => undefined}
        onConnect={() => undefined}
      />,
    );

    expect(html).toContain("2 connectors");
    expect(html).toContain("Showing 2 of 2 connectors");
    expect(html).toContain("Search");
    expect(html).toContain("Category");
    expect(html).toContain("Authentication");
    expect(html).toContain("OAuth 2.0");
    expect(html).toContain("API key");
  });

  it("shows connectors but blocks configuration without Host sealing", () => {
    const provider = {
      ...apiKeyProvider,
      missingConfig: ["OPENSESAME_CONNECTION_KEY"],
    };
    expect(canSealProviderConfiguration(provider)).toBe(false);
    const html = renderToStaticMarkup(
      <MarketplacePanel
        providers={[provider]}
        integrations={[]}
        accessRole="owner"
        busy={null}
        loading={false}
        loadIssue={null}
        onRetry={() => undefined}
        onConfigure={() => undefined}
        onConnect={() => undefined}
      />,
    );
    expect(html).toContain("Host sealing is unavailable");
    expect(html).not.toContain("Configure integration");
  });
});
