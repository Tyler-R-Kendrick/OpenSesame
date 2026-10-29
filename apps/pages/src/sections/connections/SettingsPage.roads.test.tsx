/** @vitest-environment jsdom */
import { initialDraftState } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { saveSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { awsKmsConnectDependencies } from "./AwsKmsConnectPanel.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { nativeSettingsDescriptor } from "./connect/NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

const originalIdentity = { ...identitySeams };
const originalVault = vaultHooksSeams.useVault;
const originalAws = { ...awsKmsConnectDependencies };

afterEach(() => {
  cleanup();
  Object.assign(identitySeams, originalIdentity);
  vaultHooksSeams.useVault = originalVault;
  Object.assign(awsKmsConnectDependencies, originalAws);
});

declareConnectionsTutorial();
installConnectorIntegration();

function provider(id: string): Provider {
  const found = getBundledProviders().find((row) => row.id === id);
  if (!found) throw new Error(`${id} is not bundled`);
  return found;
}

function draw(id: string, connection: Connection | null = null) {
  render(
    <MemoryRouter initialEntries={[`/settings/connections/${id}`]}>
      <ConnectorSettingsPage
        provider={provider(id)}
        providers={getBundledProviders()}
        providerId={id}
        connection={connection}
        connections={connection ? [connection] : []}
        loading={false}
        online
        canConfigure
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
}

/** A Host is named and a grant to it is live: it opens no connector road. */
function nameAHostWithALiveGrant() {
  identitySeams.hostBase = () => "https://host.test";
  identitySeams.hostLocalSessionEligible = () => true;
}

function unlocked() {
  awsKmsConnectDependencies.readAwsKmsConfig = async () => ({
    keyArn: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: null,
    label: null,
    configVersion: "0",
  });
  vaultHooksSeams.useVault = () => ({
    ...originalVault(),
    status: "unlocked",
    guest: false,
    tomb: "personal",
  });
}

describe("Linear retains configuration while its native owner is inactive", () => {
  it("labels Azure family surfaces from bundled catalog aliases", () => {
    draw("azure-key-vault-secrets");
    const family = screen.getByRole("combobox", { name: "API family" });
    expect(family).toHaveProperty("value", "azure-sm");
    expect(
      within(family).getByRole("option", { name: "Azure Key Vault Secrets" }),
    ).toHaveProperty("value", "azure-sm");
    expect(
      within(family).getByRole("option", { name: "Azure App Configuration" }),
    ).toHaveProperty("value", "azure-ac");
  });

  it("keeps advanced configuration reachable without inventing an authorization owner", () => {
    draw("linear");
    expect(
      within(screen.getByRole("region", { name: "Connector" })).getByRole(
        "heading",
        {
          name: "2 Connect",
          level: 2,
        },
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Save configuration/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect Linear/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Sign in to Linear" }),
    ).toBeNull();
    expect(
      screen.getByText("Advanced: existing OAuth app or API key"),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Not available here" }),
    ).toBeTruthy();
  });
});

describe("a named Host does not substitute for the native Linear owner", () => {
  it("retains configuration and still requires the actual activation for MCP authorization", () => {
    nameAHostWithALiveGrant();
    draw("linear");
    expect(
      within(screen.getByRole("region", { name: "Connector" })).getByRole(
        "heading",
        { name: "2 Connect", level: 2 },
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect Linear/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Authorize with Linear/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Sign in to Linear" }),
    ).toBeNull();
    expect(
      screen.getByText("Advanced: existing OAuth app or API key"),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Not available here" }),
    ).toBeTruthy();
  });
});

describe("Linear's top-level native settings route", () => {
  it("uses the common MCP form and retains advanced OAuth/key configuration when nativeExperience is true", async () => {
    const integration = connectorIntegration();
    const descriptor = nativeSettingsDescriptor(provider("linear"));
    expect(descriptor?.methods.map((method) => method.id)).toEqual(["mcp"]);
    expect(descriptor?.methods[0]?.available).toBe(true);
    draw("linear");
    expect(
      screen.getByRole("button", { name: "Sign in to Linear" }),
    ).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("MCP permissions").textContent).toContain(
      "1 selected",
    );
    expect(screen.queryByLabelText("Linear OAuth client ID")).toBeNull();
    await userEvent.click(
      screen.getByText("Advanced: existing OAuth app or API key"),
    );
    expect(screen.getByLabelText("Linear OAuth client ID")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "API key" }));
    expect(screen.getByLabelText("Linear API key")).toHaveProperty(
      "type",
      "password",
    );
    expect(
      screen.getByRole("button", { name: "Verify and connect Linear" }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByLabelText("Vercel access token")).toBeNull();
    expect(integration.requests).toHaveLength(0);
  });

  it("keeps a saved specialized Linear record on its original custody page", async () => {
    const integration = connectorIntegration();
    const plan = connectPlan("linear");
    if (!plan) throw new Error("Actual Linear plan required");
    const connection = await saveSelfHostedConnector(
      plan,
      {
        ...initialDraftState(plan, "api-key"),
        name: "Saved Linear",
        key: "synthetic-config-only",
      },
      {
        mode: "byo",
        workspace: "configured-workspace",
        appScopes: [],
        userScopes: [],
        webhookResourceTypes: [],
        icon: "",
      },
    );
    draw("linear", connection);
    expect(connection.status).toBe("pending");
    const header = screen
      .getByRole("heading", { name: "Linear", level: 1 })
      .closest("header");
    if (!header) throw new Error("Missing actual Linear settings header");
    expect(within(header).getByRole("img", { name: "Needs you" })).toBeTruthy();
    expect(header.textContent).toContain(
      "Created, but nobody has approved it yet. Authorize it to finish.",
    );
    expect(
      within(header).queryByRole("img", { name: "Not connected" }),
    ).toBeNull();
    expect(screen.getByLabelText("Linear API key")).toHaveProperty(
      "type",
      "password",
    );
    expect(screen.getByText("Linear saved connection actions")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Sign in to Linear" }),
    ).toBeNull();
    expect(
      screen.queryByText("Advanced: existing OAuth app or API key"),
    ).toBeNull();
    expect(integration.requests).toHaveLength(0);
  });

  it.each(["api-key", "oauth"] as const)(
    "retains the original saved native %s descriptor",
    (method) => {
      const integration = connectorIntegration();
      expect(
        nativeSettingsDescriptor(provider("linear"), method)?.methods.map(
          (entry) => entry.id,
        ),
      ).toEqual([method]);
      expect(integration.requests).toHaveLength(0);
    },
  );

  it("removes MCP authorization availability when its original activation retires", () => {
    const integration = connectorIntegration();
    expect(
      nativeSettingsDescriptor(provider("linear"))?.methods[0]?.available,
    ).toBe(true);
    integration.activation.dispose();
    expect(
      nativeSettingsDescriptor(provider("linear"))?.methods[0]?.available,
    ).toBe(false);
    expect(integration.requests).toHaveLength(0);
  });
});

describe("a key or a configuration seals on this device", () => {
  it.each([false, true])(
    "configures Better Auth through shared identity fields with a named Host=%s",
    (namedHost) => {
      if (namedHost) nameAHostWithALiveGrant();
      draw("better-auth");
      expect(screen.getByLabelText("Auth API base URL")).toBeTruthy();
      expect(screen.getByLabelText("Protocol")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Save identity connection" }),
      ).toBeTruthy();
      expect(
        screen.queryByText(
          /OpenSesame has no browser connection for Better Auth/,
        ),
      ).toBeNull();
    },
  );

  it("configures Anthropic through the shared inference form when Vercel also lists it", () => {
    connectorIntegration();
    draw("anthropic");
    expect(screen.getByLabelText("API key", { exact: true })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save AI connection" }),
    ).toBeTruthy();
  });

  it("composes only browser peering without OAuth management, the legacy daemon refusal or a duplicate generic form", () => {
    draw("tailscale");
    expect(
      screen.getAllByRole("region", { name: "Tailscale browser node" }),
    ).toHaveLength(1);
    expect(screen.getAllByLabelText("Browser node hostname")).toHaveLength(1);
    expect(screen.getAllByLabelText("Tailscale control server")).toHaveLength(
      1,
    );
    expect(screen.getAllByLabelText("Optional node auth key")).toHaveLength(1);
    expect(
      screen.getByLabelText("Optional node auth key").getAttribute("type"),
    ).toBe("password");
    for (const field of [
      "Tailscale API base URL",
      "App name",
      "Provisioned node attributes",
      "Redirect URI to register",
      "Returned OAuth app JSON",
      "Admin API access token",
      "Issued device auth key",
      "Tailnet",
    ])
      expect(screen.queryByLabelText(field, { exact: true })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Connect browser node" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /Download registration request|Register app with Tailscale|Save returned Tailscale app|Prepare device key handoff/,
      }),
    ).toBeNull();
    expect(
      screen.queryByText(/device enrollment requires tailscaled/),
    ).toBeNull();
    expect(screen.queryByLabelText("Auth key (required)")).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Tailscale OAuth app configuration",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Tailscale device provisioning" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save configuration" }),
    ).toBeNull();
  });
});

describe("a connector page that seals in the vault", () => {
  it("draws nothing for a guest or a locked vault", () => {
    vaultStore.lock();
    draw("aws-kms");
    expect(screen.queryByRole("heading", { name: "Connect" })).toBeNull();
    expect(
      screen.getByRole("img", { name: "Not available here" }),
    ).toBeTruthy();
  });

  it("draws its panel once a vault is unlocked", () => {
    unlocked();
    draw("aws-kms");
    expect(screen.getByRole("heading", { name: "Connect" })).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: "Not available here" }),
    ).toBeNull();
  });
});

describe("a connector page the browser acts on alone", () => {
  it("keeps its Connect panel with no Host at all", () => {
    draw("git");
    expect(screen.getByRole("heading", { name: "Connect" })).toBeTruthy();
    expect(screen.getByLabelText(/Remote URL/i)).toBeTruthy();
  });

  it("offers GitHub's compiled token route with no runtime bound, and never server-backed App registration", () => {
    // No `connectorIntegration()` here: no driver has activated. The compiled
    // contract still configures, so the page must not say "Not available here".
    draw("github");
    expect(
      screen.queryByRole("button", {
        name: /Create GitHub App for this organization/i,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Not available here" }),
    ).toBeNull();
    expect(screen.getByRole("img", { name: "Not connected" })).toBeTruthy();
    expect(screen.getByLabelText("GitHub personal access token")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Authorize with GitHub/i }),
    ).toBeNull();
  });
});
