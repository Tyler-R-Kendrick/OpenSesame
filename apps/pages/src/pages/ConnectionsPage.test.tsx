import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Integration, Provider } from "../lib/connections.js";
import { IntegrationsPanel, MarketplacePanel } from "./ConnectionsPage.js";

const oauthProvider: Provider = {
  id: "github",
  displayName: "GitHub",
  category: "developer",
  docsUrl: "https://docs.github.com",
  authKind: "oauth2_authorization_code",
  callbackUrl: "https://host.example/api/v1/connections/oauth/callback",
  scopes: [],
};

const apiKeyProvider: Provider = {
  ...oauthProvider,
  id: "linear",
  displayName: "Linear",
  authKind: "api_key",
  callbackUrl: null,
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
  };
}

describe("Connections marketplace panels", () => {
  it("branches member connection forms by provider auth kind", () => {
    const html = renderToStaticMarkup(
      <MarketplacePanel
        providers={[oauthProvider, apiKeyProvider]}
        integrations={[integration("github"), integration("linear")]}
        accessRole="member"
        busy={null}
        onConfigure={() => undefined}
        onConnect={() => undefined}
      />,
    );

    expect(html).toContain("Authorize account");
    expect(html).toContain("Seal API key");
    expect(html).toContain('name="credential"');
    expect(html).not.toContain("Configure integration");
  });

  it("shows OAuth configuration only for OAuth providers", () => {
    const oauth = renderToStaticMarkup(
      <MarketplacePanel
        providers={[oauthProvider]}
        integrations={[]}
        accessRole="admin"
        busy={null}
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
        onConfigure={() => undefined}
        onConnect={() => undefined}
      />,
    );

    expect(oauth).toContain("OAuth callback URL");
    expect(oauth).toContain("OAuth client secret");
    expect(apiKey).not.toContain("OAuth client secret");
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
        onRotate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Development only");
    expect(html).toContain("deployment-managed integration is read-only");
    expect(html).not.toContain("Rotate OAuth credentials");
    expect(html).not.toContain("Delete integration");
  });
});
