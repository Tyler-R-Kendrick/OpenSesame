import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = vi.hoisted(() => ({ value: true }));
const session = vi.hoisted(() => ({
  current: { principalId: "prn_op" } as { principalId: string } | null,
}));
const hostEligible = vi.hoisted(() => ({ value: true }));
const connect = vi.hoisted(() => vi.fn());
const connectState = vi.hoisted(() => ({
  connecting: false,
  error: null as string | null,
}));

const HostSessionError = vi.hoisted(() => {
  return class HostSessionError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  };
});

const ensureHostSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("../lib/identity.js", () => ({
  HostSessionError,
  ensureHostSession,
  hostBase: () => "http://127.0.0.1:8787",
  hostLocalSessionEligible: () => hostEligible.value,
  useConnect: () => ({
    connect,
    connecting: connectState.connecting,
    error: connectState.error,
  }),
  useIdentitySession: () => session.current,
}));

vi.mock("../lib/use-online.js", () => ({ useOnline: () => online.value }));

const shouldAutoConnect = vi.hoisted(() => vi.fn(() => true));
vi.mock("../lib/settings.js", () => ({ shouldAutoConnect }));

const vault = vi.hoisted(() => ({ items: [] as unknown[] }));
const addItems = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const saveItem = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../lib/vault/hooks.js", () => ({
  useVault: () => vault,
  useVaultStore: () => ({ addItems, saveItem }),
}));

vi.mock("../components/PlaneNote.js", () => ({
  PagesCannotHostNote: () => null,
}));
vi.mock("../components/PasskeyCeremonyNote.js", () => ({
  PasskeyCeremonyNote: () => null,
}));

const ConnectionsError = vi.hoisted(() => {
  return class ConnectionsError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  };
});

const listProviders = vi.hoisted(() => vi.fn());
const listConnections = vi.hoisted(() => vi.fn());
const discoverConnections = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const createConnection = vi.hoisted(() => vi.fn());
const authorizeConnection = vi.hoisted(() => vi.fn());
const awaitConsent = vi.hoisted(() => vi.fn());
const revokeConnection = vi.hoisted(() => vi.fn());
const refreshConnection = vi.hoisted(() => vi.fn());
const bindConnection = vi.hoisted(() => vi.fn());
const unbindConnection = vi.hoisted(() => vi.fn());
const updateConnectionPolicy = vi.hoisted(() => vi.fn());
const connectionEvents = vi.hoisted(() => vi.fn());
const setConnectionCredential = vi.hoisted(() => vi.fn());
const setConnectionConfiguration = vi.hoisted(() => vi.fn());
const listIntegrations = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const openConsentPopup = vi.hoisted(() => vi.fn(() => null));
const startGithubAppRegistration = vi.hoisted(() => vi.fn());
const submitGithubAppManifest = vi.hoisted(() => vi.fn());

vi.mock("../lib/connections.js", () => ({
  ConnectionsError,
  listProviders,
  listConnections,
  discoverConnections,
  createConnection,
  authorizeConnection,
  awaitConsent,
  revokeConnection,
  refreshConnection,
  bindConnection,
  unbindConnection,
  updateConnectionPolicy,
  connectionEvents,
  setConnectionCredential,
  setConnectionConfiguration,
  listIntegrations,
  openConsentPopup,
  startGithubAppRegistration,
  submitGithubAppManifest,
}));

const catalog = vi.hoisted(() => {
  const githubProvider = {
    id: "github",
    displayName: "GitHub",
    category: "developer",
    docsUrl: "https://docs.github.com",
    authKind: "oauth2_authorization_code",
    supportsRefresh: true,
    configured: false,
    autoConfigurable: false,
    missingConfig: ["GITHUB_CLIENT_ID"],
    callbackUrl: null,
    scopes: [
      {
        name: "repo",
        description: "Full repository access",
        sensitive: true,
        default: true,
      },
    ],
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    operations: [],
  };

  const linearProvider = {
    id: "linear",
    displayName: "Linear",
    category: "developer",
    docsUrl: "https://linear.app/docs",
    authKind: "oauth2_authorization_code",
    supportsRefresh: true,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: {
      scheme: "https",
      authorities: ["api.linear.app"],
      pathPrefixes: [],
    },
    operations: [],
  };

  const vercelProvider = {
    id: "vercel",
    displayName: "Vercel",
    category: "developer",
    docsUrl: "https://vercel.com/docs",
    authKind: "api_key",
    supportsRefresh: false,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: {
      scheme: "https",
      authorities: ["api.vercel.com"],
      pathPrefixes: [],
    },
    operations: [],
  };

  const plainProvider = {
    id: "plain",
    displayName: "Plain storage",
    category: "local_storage",
    docsUrl: "https://example.com/docs",
    authKind: "configuration",
    supportsRefresh: false,
    configured: true,
    autoConfigurable: true,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: [],
  };

  const vaultwardenProvider = {
    id: "vaultwarden",
    displayName: "Vaultwarden",
    category: "password_managers",
    docsUrl: "https://example.com/vw",
    authKind: "configuration",
    supportsRefresh: false,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: [],
    configurationFields: [
      {
        name: "server_url",
        label: "Server URL",
        secret: false,
        required: true,
      },
      { name: "api_key", label: "API key", secret: true, required: false },
    ],
  };

  return [
    githubProvider,
    linearProvider,
    vercelProvider,
    plainProvider,
    vaultwardenProvider,
  ];
});

const bundledRef = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("../lib/embedded-catalog.js", () => ({
  get bundledProviders() {
    return bundledRef.current;
  },
  readEmbeddedProviders: vi.fn(() => Promise.resolve(bundledRef.current)),
  writeEmbeddedProviders: vi.fn().mockResolvedValue(undefined),
}));

import type { Connection } from "../lib/connections.js";
import { kvDelete } from "../lib/kv.js";
import { ConnectionsSection } from "./ConnectionsSection.js";

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    connectionId: "con_1",
    connectionRef: "conn/github/pat",
    logicalName: "github",
    displayName: "GitHub",
    providerId: "github",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "org_1",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: ["repo"],
    grantedScopes: ["repo"],
    accountLabel: "octocat",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshable: true,
    lastRefreshedAt: null,
    maxInvokeLevel: 2,
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    bindings: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  } as Connection;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/connections" element={<ConnectionsSection />} />
        <Route
          path="/connections/:providerId"
          element={<ConnectionsSection />}
        />
        <Route
          path="/connections/:providerId/:connectionId"
          element={<ConnectionsSection />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ConnectionsSection gallery", () => {
  beforeEach(() => {
    online.value = true;
    session.current = { principalId: "prn_op" };
    hostEligible.value = true;
    connectState.connecting = false;
    connectState.error = null;
    shouldAutoConnect.mockReturnValue(true);
    listProviders.mockResolvedValue(catalog);
    bundledRef.current = catalog;
    listConnections.mockResolvedValue([]);
    connectionEvents.mockResolvedValue([]);
    discoverConnections.mockResolvedValue(0);
    vault.items = [];
    kvDelete("connections.firstRun.v1");
    window.history.replaceState({}, "", "/connections");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the catalog grouped by category", async () => {
    renderAt("/connections");
    expect(
      await screen.findByRole("heading", { name: "Connections" }),
    ).toBeTruthy();
    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Linear").length).toBeGreaterThan(0);
    expect(screen.getByText("Vaultwarden")).toBeTruthy();
    expect(screen.getByText("Developer tools")).toBeTruthy();
    expect(screen.getByText("Password managers")).toBeTruthy();
    // The automatic provider is offered as a switch, not a marketplace tile.
    expect(
      screen.getByRole("switch", { name: /Enable Plain storage/i }),
    ).toBeTruthy();
  });

  it("filters the gallery by search and clears it", async () => {
    const { container } = renderAt("/connections");
    await screen.findByText("Vaultwarden");
    // Dismiss the first-run panel so tile names are unambiguous.
    await userEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    const grid = () => container.querySelector(".conn-grid") as HTMLElement;
    await userEvent.type(
      screen.getByPlaceholderText("Search connectors"),
      "linear",
    );
    expect(within(grid()).getByText("Linear")).toBeTruthy();
    expect(container.querySelectorAll(".conn-tile").length).toBe(1);
    expect(screen.getByText(/1 of 4 connectors/)).toBeTruthy();
    await userEvent.clear(screen.getByPlaceholderText("Search connectors"));
    await userEvent.type(
      screen.getByPlaceholderText("Search connectors"),
      "zzzz",
    );
    expect(screen.getByText("No matching connectors")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Clear search/i }),
    );
    expect(container.querySelectorAll(".conn-tile").length).toBe(4);
  });

  it("shows the unreachable-Host error when connections cannot load", async () => {
    listConnections.mockRejectedValue(
      new ConnectionsError(0, "unreachable", "fetch failed"),
    );
    renderAt("/connections");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Host API unavailable/);
  });

  it("gates on organization setup when the Host session needs it", async () => {
    listConnections.mockRejectedValue(
      new HostSessionError("setup_required", "No organization selected."),
    );
    renderAt("/connections");
    expect(
      await screen.findByText(/Choose an organization to manage connections/),
    ).toBeTruthy();
  });

  it("warns when the catalog falls back to the bundled copy", async () => {
    listProviders.mockRejectedValue(
      new ConnectionsError(0, "unreachable", "fetch failed"),
    );
    renderAt("/connections");
    expect(
      await screen.findByText(/Host catalog did not refresh/),
    ).toBeTruthy();
    // Bundled providers still render.
    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
  });

  it("warns when the Host is missing its sealing key", async () => {
    listProviders.mockResolvedValue([
      { ...catalog[1], missingConfig: ["OPENSESAME_CONNECTION_KEY"] },
    ]);
    renderAt("/connections");
    expect(
      await screen.findByText(/credentials cannot be sealed yet/),
    ).toBeTruthy();
  });

  it("enables an automatic service and offers a vault reminder", async () => {
    createConnection.mockResolvedValue(
      makeConnection({
        connectionId: "con_plain",
        providerId: "plain",
        displayName: "Plain storage",
      }),
    );
    renderAt("/connections");
    await userEvent.click(
      await screen.findByRole("switch", { name: /Enable Plain storage/i }),
    );
    expect(await screen.findByText(/Plain storage is enabled/)).toBeTruthy();
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "plain" }),
    );
    // The reminder banner offers to save a vault pointer.
    expect(screen.getByText(/Add a vault reminder/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Remember in vault/i }),
    );
    await waitFor(() => expect(addItems).toHaveBeenCalled());
    expect(
      await screen.findByText(/Added a vault reminder for Plain storage/),
    ).toBeTruthy();
  });

  it("disables an automatic service", async () => {
    listConnections.mockResolvedValue([
      makeConnection({
        connectionId: "con_plain",
        providerId: "plain",
        displayName: "Plain storage",
      }),
    ]);
    revokeConnection.mockResolvedValue({ providerRevocation: "ok" });
    renderAt("/connections");
    await screen.findByText(/Plain storage/);
    await userEvent.click(
      screen.getByRole("switch", { name: /Disable Plain storage/i }),
    );
    await waitFor(() =>
      expect(revokeConnection).toHaveBeenCalledWith("con_plain"),
    );
    expect(await screen.findByText(/Plain storage is disabled/)).toBeTruthy();
  });

  it("surfaces automatic-service failures", async () => {
    createConnection.mockRejectedValue(new Error("host busy"));
    renderAt("/connections");
    await userEvent.click(
      await screen.findByRole("switch", { name: /Enable Plain storage/i }),
    );
    expect(await screen.findByText(/host busy/)).toBeTruthy();
  });

  it("lists unfinished connections in the Needs you inbox", async () => {
    listConnections.mockResolvedValue([
      makeConnection({ status: "pending", displayName: "GitHub work" }),
    ]);
    renderAt("/connections");
    expect(
      await screen.findByRole("heading", { name: "Needs you" }),
    ).toBeTruthy();
    expect(screen.getAllByText("GitHub work").length).toBeGreaterThan(0);
    // The sentence shows in both the inbox and the services list.
    expect(
      screen.getAllByText(/Created, but nobody has approved it yet/).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: /Fix/i })).toBeTruthy();
  });

  it("shows the first-run three and dismisses them", async () => {
    renderAt("/connections");
    expect(
      await screen.findByText(/Connect the three you use daily/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(screen.queryByText(/Connect the three you use daily/)).toBeNull();
  });

  it("shows managed connections with a status sentence", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    renderAt("/connections");
    expect(await screen.findByText(/Authorized as octocat/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Settings for GitHub/i }),
    ).toBeTruthy();
  });

  it("auto-connects identity when neither session nor local Host applies", async () => {
    session.current = null;
    hostEligible.value = false;
    connect.mockResolvedValue(undefined);
    renderAt("/connections");
    await waitFor(() => expect(connect).toHaveBeenCalled());
  });
});

describe("ConnectionsSection connector page", () => {
  beforeEach(() => {
    online.value = true;
    session.current = { principalId: "prn_op" };
    hostEligible.value = true;
    shouldAutoConnect.mockReturnValue(true);
    listProviders.mockResolvedValue(catalog);
    bundledRef.current = catalog;
    listConnections.mockResolvedValue([]);
    connectionEvents.mockResolvedValue([]);
    vault.items = [];
    kvDelete("connections.firstRun.v1");
    window.history.replaceState({}, "", "/connections/github");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("reports an unknown connector", async () => {
    renderAt("/connections/nope");
    expect(await screen.findByText("Connector not found")).toBeTruthy();
  });

  it("deploys a tenant GitHub App from the connector page", async () => {
    startGithubAppRegistration.mockResolvedValue({
      action: "https://github.com/settings/apps/new",
      state: "st",
      manifest: {},
      redirectUrl: "https://host/cb",
    });
    renderAt("/connections/github");
    const button = await screen.findByRole("button", {
      name: /Create GitHub App for this organization/i,
    });
    await userEvent.click(button);
    expect(
      await screen.findByText(/Sending you to GitHub to create the app/),
    ).toBeTruthy();
    expect(submitGithubAppManifest).toHaveBeenCalled();
  });

  it("reports GitHub App deployment failures", async () => {
    startGithubAppRegistration.mockRejectedValue(new Error("no host"));
    renderAt("/connections/github");
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Create GitHub App for this organization/i,
      }),
    );
    expect(await screen.findByText(/no host/)).toBeTruthy();
  });

  it("connects GitHub with a personal access token", async () => {
    const created = makeConnection({ connectionId: "con_new" });
    createConnection.mockResolvedValue(created);
    setConnectionCredential.mockResolvedValue(created);
    renderAt("/connections/github");
    const input = await screen.findByLabelText(
      /connect with a personal access token/i,
    );
    await userEvent.type(input, "ghp_secret");
    await userEvent.click(
      screen.getByRole("button", { name: /Connect GitHub with token/i }),
    );
    await waitFor(() =>
      expect(setConnectionCredential).toHaveBeenCalledWith(
        "con_new",
        "ghp_secret",
      ),
    );
    expect(
      await screen.findByText(/GitHub credential stored on this Host/),
    ).toBeTruthy();
  });

  it("maps a bad-PAT exchange failure to plain advice", async () => {
    createConnection.mockResolvedValue(makeConnection());
    setConnectionCredential.mockRejectedValue(
      new ConnectionsError(401, "exchange_failed", "401 bad credentials"),
    );
    renderAt("/connections/github");
    await userEvent.type(
      await screen.findByLabelText(/connect with a personal access token/i),
      "ghp_bad",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Connect GitHub with token/i }),
    );
    expect(await screen.findByText(/GitHub rejected that token/)).toBeTruthy();
  });

  it("runs the OAuth consent flow for a configured provider", async () => {
    const created = makeConnection({ providerId: "linear" });
    createConnection.mockResolvedValue(created);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://linear.app/oauth/authorize",
    });
    awaitConsent.mockResolvedValue({ result: "active", connection: created });
    renderAt("/connections/linear");
    await userEvent.click(
      await screen.findByRole("button", { name: /Authorize with Linear/i }),
    );
    expect(
      await screen.findByText(/Linear is connected as octocat/),
    ).toBeTruthy();
    // The consent page URL was assigned for the same-tab navigation.
    expect(authorizeConnection).toHaveBeenCalledWith("con_1", []);
  });

  it("warns when consent is abandoned", async () => {
    const created = makeConnection({ providerId: "linear" });
    createConnection.mockResolvedValue(created);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://linear.app/oauth/authorize",
    });
    awaitConsent.mockResolvedValue({
      result: "cancelled",
      connection: created,
    });
    renderAt("/connections/linear");
    await userEvent.click(
      await screen.findByRole("button", { name: /Authorize with Linear/i }),
    );
    expect(
      await screen.findByText(/Consent for Linear was not completed/),
    ).toBeTruthy();
  });

  it("saves an API key for key-based providers", async () => {
    const created = makeConnection({ providerId: "vercel" });
    createConnection.mockResolvedValue(created);
    setConnectionCredential.mockResolvedValue(created);
    renderAt("/connections/vercel");
    await userEvent.type(
      await screen.findByLabelText(/API key/i),
      "vcel_secret",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Connect Vercel$/i }),
    );
    await waitFor(() =>
      expect(setConnectionCredential).toHaveBeenCalledWith(
        "con_1",
        "vcel_secret",
      ),
    );
    expect(
      await screen.findByText(/Vercel credential stored on this Host/),
    ).toBeTruthy();
  });

  it("saves configuration for configuration-based providers", async () => {
    const created = makeConnection({ providerId: "vaultwarden" });
    createConnection.mockResolvedValue(created);
    setConnectionConfiguration.mockResolvedValue(created);
    renderAt("/connections/vaultwarden");
    await userEvent.type(
      await screen.findByLabelText(/Server URL/),
      "https://vw.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save configuration/i }),
    );
    await waitFor(() =>
      expect(setConnectionConfiguration).toHaveBeenCalledWith(
        "con_1",
        expect.objectContaining({ server_url: "https://vw.example.com" }),
      ),
    );
    expect(
      await screen.findByText(/Vaultwarden configuration saved on this Host/),
    ).toBeTruthy();
  });

  it("shows the connection card with scopes, egress, and renewal", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    refreshConnection.mockResolvedValue(makeConnection());
    renderAt("/connections/github/con_1");
    expect((await screen.findAllByText(/octocat/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("api.github.com").length).toBeGreaterThan(0);
    expect(screen.getByText("Full repository access")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Renew now/i }));
    await waitFor(() =>
      expect(refreshConnection).toHaveBeenCalledWith("con_1"),
    );
    expect(await screen.findByText(/was renewed/)).toBeTruthy();
  });

  it("shows connection history on demand", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    connectionEvents.mockResolvedValue([
      {
        id: "evt_1",
        kind: "authorized",
        at: "2026-08-10T10:00:00Z",
        detail: "by prn_op",
      },
    ]);
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.click(
      screen.getAllByRole("button", { name: /History/i })[0] as HTMLElement,
    );
    expect((await screen.findAllByText("authorized")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/by prn_op/).length).toBeGreaterThan(0);
  });

  it("revokes a connection through the confirm strip", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    revokeConnection.mockResolvedValue({ providerRevocation: "ok" });
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.click(
      screen.getAllByRole("button", { name: /^Revoke$/i })[0] as HTMLElement,
    );
    expect(
      screen.getByText(/Revoking cuts off every project and agent/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Keep it/i }));
    expect(revokeConnection).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getAllByRole("button", { name: /^Revoke$/i })[0] as HTMLElement,
    );
    await userEvent.click(screen.getByRole("button", { name: /Revoke it/i }));
    await waitFor(() => expect(revokeConnection).toHaveBeenCalledWith("con_1"));
    expect(await screen.findByText(/GitHub was revoked/)).toBeTruthy();
  });

  it("warns when provider-side revocation fails", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    revokeConnection.mockResolvedValue({ providerRevocation: "failed" });
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.click(
      screen.getAllByRole("button", { name: /^Revoke$/i })[0] as HTMLElement,
    );
    await userEvent.click(screen.getByRole("button", { name: /Revoke it/i }));
    expect(
      await screen.findByText(/removed locally, but provider revocation/),
    ).toBeTruthy();
  });

  it("binds and unbinds targets", async () => {
    const bound = makeConnection({
      bindings: [
        {
          id: "bnd_1",
          targetKind: "project",
          targetId: "proj_1",
          targetLabel: "proj_1",
          createdAt: "2026-08-01T00:00:00Z",
        },
      ],
    });
    listConnections.mockResolvedValue([bound]);
    bindConnection.mockResolvedValue({});
    unbindConnection.mockResolvedValue({});
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);

    // Existing binding renders with an unbind control.
    await userEvent.click(
      screen.getAllByRole("button", {
        name: /Unbind proj_1/i,
      })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(unbindConnection).toHaveBeenCalledWith("con_1", "bnd_1"),
    );

    // Add a new project binding.
    await userEvent.click(
      screen.getAllByRole("button", {
        name: /Bind an identity/i,
      })[0] as HTMLElement,
    );
    await userEvent.type(screen.getByLabelText(/Identifier/i), "proj_9");
    await userEvent.click(screen.getByRole("button", { name: /^Bind$/i }));
    await waitFor(() =>
      expect(bindConnection).toHaveBeenCalledWith("con_1", {
        targetKind: "project",
        targetId: "proj_9",
      }),
    );
  });

  it("rejects a non-agent id for agent bindings", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.click(
      screen.getAllByRole("button", {
        name: /Bind an identity/i,
      })[0] as HTMLElement,
    );
    await userEvent.selectOptions(screen.getByLabelText(/^Kind$/i), "agent");
    await userEvent.type(screen.getByLabelText(/Identifier/i), "user:demo");
    await userEvent.click(screen.getByRole("button", { name: /^Bind$/i }));
    expect(await screen.findByText(/not user:demo/)).toBeTruthy();
    expect(bindConnection).not.toHaveBeenCalled();
  });

  it("saves connector rules", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    updateConnectionPolicy.mockResolvedValue(makeConnection());
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.selectOptions(
      screen.getByLabelText(/Delegation/i),
      "organization_wide",
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/Maximum action/i),
      "1",
    );
    await userEvent.click(screen.getByRole("button", { name: /Save rules/i }));
    await waitFor(() =>
      expect(updateConnectionPolicy).toHaveBeenCalledWith("con_1", {
        shareability: "organization_wide",
        maxInvokeLevel: 1,
      }),
    );
    expect(await screen.findByText(/Connector rules saved/)).toBeTruthy();
  });

  it("grants the connection to an agent and records a reminder", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    bindConnection.mockResolvedValue({});
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.type(
      screen.getByLabelText(/Grant to agent/i),
      "agt_release_bot",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Grant$/i }));
    await waitFor(() =>
      expect(bindConnection).toHaveBeenCalledWith("con_1", {
        targetKind: "agent",
        targetId: "agt_release_bot",
      }),
    );
    // No reminder existed, so a new one was added to the vault.
    await waitFor(() => expect(addItems).toHaveBeenCalled());
    expect(
      await screen.findByText(/can invoke GitHub through the Host/),
    ).toBeTruthy();
  });

  it("updates an existing reminder when granting to an agent", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    bindConnection.mockResolvedValue({});
    vault.items = [
      {
        id: "itm_r",
        kind: "secret",
        name: "GitHub reminder",
        deletedAt: null,
        connectionRef: "conn/github/pat",
        grantees: [],
        ceiling: [],
        fields: [],
        value: "",
      },
    ];
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.type(
      screen.getByLabelText(/Grant to agent/i),
      "agt_release_bot",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Grant$/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(addItems).not.toHaveBeenCalled();
  });

  it("rejects an invalid agent id in the grant form", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.type(screen.getByLabelText(/Grant to agent/i), "user:demo");
    await userEvent.click(screen.getByRole("button", { name: /^Grant$/i }));
    expect(
      await screen.findByText(/Workload identity is an agent id/),
    ).toBeTruthy();
    expect(bindConnection).not.toHaveBeenCalled();
  });
});

describe("ConnectionsSection deeper branches", () => {
  beforeEach(() => {
    online.value = true;
    session.current = { principalId: "prn_op" };
    hostEligible.value = true;
    shouldAutoConnect.mockReturnValue(true);
    listProviders.mockResolvedValue(catalog);
    bundledRef.current = catalog;
    listConnections.mockResolvedValue([]);
    connectionEvents.mockResolvedValue([]);
    discoverConnections.mockResolvedValue(0);
    vault.items = [];
    kvDelete("connections.firstRun.v1");
    window.history.replaceState({}, "", "/connections");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("announces auto-configured connectors after a reload", async () => {
    discoverConnections.mockResolvedValue(2);
    renderAt("/connections");
    expect(
      await screen.findByText(/2 connectors already configured/),
    ).toBeTruthy();
  });

  it("renders the offline note and disables reload", async () => {
    online.value = false;
    renderAt("/connections");
    expect(await screen.findByText(/This browser is offline/)).toBeTruthy();
  });

  it("shows sentences for reauth and expired connections", async () => {
    listConnections.mockResolvedValue([
      makeConnection({
        connectionId: "con_reauth",
        displayName: "Reauth me",
        status: "needs_reauth",
        statusDetail: "Renewal refused by GitHub.",
      }),
      makeConnection({
        connectionId: "con_expired",
        displayName: "Expired one",
        status: "expired",
        refreshable: false,
      }),
    ]);
    renderAt("/connections");
    // The sentence shows in both the inbox and the services list.
    expect(
      (await screen.findAllByText("Renewal refused by GitHub.")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/The access token expired and there is no refresh/)
        .length,
    ).toBeGreaterThan(0);
  });

  it("describes api_key and configuration connections", async () => {
    listConnections.mockResolvedValue([
      makeConnection({
        connectionId: "con_key",
        displayName: "Vercel key",
        providerId: "vercel",
        refreshable: false,
      }),
    ]);
    renderAt("/connections");
    expect(
      await screen.findByText(/Credential stored as octocat/),
    ).toBeTruthy();
  });

  it("offers the multi-authorization picker when a provider has two", async () => {
    listConnections.mockResolvedValue([
      makeConnection({
        connectionId: "con_a",
        providerId: "linear",
        displayName: "Linear work",
      }),
      makeConnection({
        connectionId: "con_b",
        providerId: "linear",
        displayName: "Linear personal",
      }),
    ]);
    renderAt("/connections/linear");
    expect(await screen.findByText("2 authorizations")).toBeTruthy();
    expect(screen.getByText("Linear work")).toBeTruthy();
    expect(screen.getByText("Linear personal")).toBeTruthy();
    // Adding another authorization is offered for configured providers.
    expect(screen.getByText("Add another authorization")).toBeTruthy();
  });

  it("shows the deployment guide for an unconfigured non-GitHub provider", async () => {
    listProviders.mockResolvedValue([
      { ...catalog[1], configured: false, missingConfig: ["LINEAR_CLIENT_ID"] },
    ]);
    renderAt("/connections/linear");
    expect(
      await screen.findByText(/Create an OAuth app registration/),
    ).toBeTruthy();
    expect(screen.getByText(/LINEAR_CLIENT_ID/)).toBeTruthy();
    expect(screen.getByText(/Register this exact callback URL/)).toBeTruthy();
  });

  it("re-authorizes from the connection card", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize",
    });
    awaitConsent.mockResolvedValue({
      result: "active",
      connection: makeConnection(),
    });
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.click(
      screen.getAllByRole("button", {
        name: /Re-authorize/i,
      })[0] as HTMLElement,
    );
    expect(await screen.findByText(/GitHub is authorized again/)).toBeTruthy();
  });

  it("reports a failed re-authorization", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize",
    });
    awaitConsent.mockResolvedValue({
      result: "failed",
      connection: makeConnection({ statusDetail: "user said no" }),
    });
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.click(
      screen.getAllByRole("button", {
        name: /Re-authorize/i,
      })[0] as HTMLElement,
    );
    expect(await screen.findByText(/user said no/)).toBeTruthy();
  });

  it("shows an activity log error", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    connectionEvents.mockRejectedValue(new Error("log store down"));
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.click(
      screen.getAllByRole("button", { name: /History/i })[0] as HTMLElement,
    );
    // The log renders in both the card and the identity graph panel.
    expect(
      (await screen.findAllByText(/log store down/)).length,
    ).toBeGreaterThan(0);
  });

  it("reports unbind failures", async () => {
    listConnections.mockResolvedValue([
      makeConnection({
        bindings: [
          {
            id: "bnd_1",
            targetKind: "project",
            targetId: "proj_1",
            targetLabel: null,
            createdAt: "2026-08-01T00:00:00Z",
          },
        ],
      }),
    ]);
    unbindConnection.mockRejectedValue(new Error("still in use"));
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.click(
      screen.getAllByRole("button", {
        name: /Unbind proj_1/i,
      })[0] as HTMLElement,
    );
    expect(await screen.findByText(/still in use/)).toBeTruthy();
  });

  it("reports policy save failures", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    updateConnectionPolicy.mockRejectedValue(new Error("policy rejected"));
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    await userEvent.click(screen.getByRole("button", { name: /Save rules/i }));
    expect(await screen.findByText(/policy rejected/)).toBeTruthy();
  });

  it("maps provider_unconfigured PAT errors to plain advice", async () => {
    createConnection.mockResolvedValue(makeConnection());
    setConnectionCredential.mockRejectedValue(
      new ConnectionsError(400, "provider_unconfigured", "no client creds"),
    );
    renderAt("/connections/github");
    await screen.findByLabelText(/connect with a personal access token/i);
    await userEvent.type(
      screen.getByLabelText(/connect with a personal access token/i),
      "ghp_x",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Connect GitHub with token/i }),
    );
    expect(
      await screen.findByText(/OAuth App credentials are not set on this Host/),
    ).toBeTruthy();
  });

  it("handles a GitHub App registration redirect with a reason", async () => {
    window.history.replaceState(
      {},
      "",
      "/connections/github?github_app=error&reason=denied",
    );
    renderAt("/connections/github");
    expect(
      await screen.findByText(/GitHub App registration failed: denied/),
    ).toBeTruthy();
  });

  it("confirms a GitHub App registration redirect", async () => {
    window.history.replaceState(
      {},
      "",
      "/connections/github?github_app=registered",
    );
    renderAt("/connections/github");
    expect(
      await screen.findByText(/GitHub App registered for this organization/),
    ).toBeTruthy();
  });

  it("toggles scopes off and warns that one is required", async () => {
    listIntegrations.mockResolvedValue([
      {
        id: "int_gh",
        providerId: "github",
        enabled: true,
        configured: true,
        source: "organization",
        displayName: "Org App",
      },
    ]);
    renderAt("/connections/github");
    const scope = await screen.findByLabelText(/repo/);
    await userEvent.click(scope);
    expect(await screen.findByText(/Pick at least one scope/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Authorize with GitHub/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("hides the first-run panel once every pick is connected", async () => {
    listConnections.mockResolvedValue([
      makeConnection(),
      makeConnection({
        connectionId: "con_l",
        providerId: "linear",
        displayName: "Linear",
      }),
      makeConnection({
        connectionId: "con_v",
        providerId: "vercel",
        displayName: "Vercel",
      }),
    ]);
    renderAt("/connections");
    await screen.findAllByText(/octocat/);
    expect(screen.queryByText(/Connect the three you use daily/)).toBeNull();
  });

  it("shows the identity session note when connect previously failed", async () => {
    session.current = null;
    hostEligible.value = false;
    shouldAutoConnect.mockReturnValue(false);
    connectState.error = "identity down";
    renderAt("/connections");
    expect(
      await screen.findByText(/OpenSesame Identity is unreachable/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Try Identity again/i }),
    );
    expect(connect).toHaveBeenCalled();
  });
});

describe("ConnectionsSection remaining branches", () => {
  beforeEach(() => {
    online.value = true;
    session.current = { principalId: "prn_op" };
    hostEligible.value = true;
    connectState.connecting = false;
    connectState.error = null;
    shouldAutoConnect.mockReturnValue(true);
    listProviders.mockResolvedValue(catalog);
    bundledRef.current = catalog;
    listConnections.mockResolvedValue([]);
    connectionEvents.mockResolvedValue([]);
    discoverConnections.mockResolvedValue(0);
    vault.items = [];
    kvDelete("connections.firstRun.v1");
    window.history.replaceState({}, "", "/connections");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("uses the singular flash for one auto-configured connector", async () => {
    discoverConnections.mockResolvedValue(1);
    renderAt("/connections");
    expect(
      await screen.findByText(/1 connector already configured/),
    ).toBeTruthy();
  });

  it("describes configuration-kind and non-refreshing connections", async () => {
    listConnections.mockResolvedValue([
      makeConnection({
        connectionId: "con_cfg",
        providerId: "vaultwarden",
        displayName: "Vaultwarden config",
        refreshable: false,
      }),
      makeConnection({
        connectionId: "con_norf",
        providerId: "github",
        displayName: "GitHub long-lived",
        refreshable: false,
        expiresAt: null,
      }),
    ]);
    renderAt("/connections");
    expect(
      await screen.findByText(/Configuration saved on this Host/),
    ).toBeTruthy();
    expect(
      screen.getByText(/issues a long-lived token with no refresh/),
    ).toBeTruthy();
  });

  it("describes a broken connection with its status detail", async () => {
    listConnections.mockResolvedValue([
      makeConnection({
        connectionId: "con_err",
        displayName: "Broken one",
        status: "error",
        statusDetail: "The provider returned an error.",
      }),
    ]);
    renderAt("/connections");
    expect(
      await screen.findAllByText("The provider returned an error."),
    ).not.toHaveLength(0);
  });

  it("dismisses the vault reminder banner without saving", async () => {
    createConnection.mockResolvedValue(
      makeConnection({
        connectionId: "con_plain",
        providerId: "plain",
        displayName: "Plain storage",
      }),
    );
    renderAt("/connections");
    await userEvent.click(
      await screen.findByRole("switch", { name: /Enable Plain storage/i }),
    );
    await screen.findByText(/Add a vault reminder/);
    await userEvent.click(screen.getByRole("button", { name: /Not now/i }));
    expect(screen.queryByText(/Add a vault reminder/)).toBeNull();
    expect(addItems).not.toHaveBeenCalled();
  });

  it("reports reminder save failures", async () => {
    createConnection.mockResolvedValue(
      makeConnection({
        connectionId: "con_plain",
        providerId: "plain",
        displayName: "Plain storage",
      }),
    );
    addItems.mockRejectedValue(new Error("vault sealed"));
    renderAt("/connections");
    await userEvent.click(
      await screen.findByRole("switch", { name: /Enable Plain storage/i }),
    );
    await screen.findByText(/Add a vault reminder/);
    await userEvent.click(
      screen.getByRole("button", { name: /Remember in vault/i }),
    );
    expect(await screen.findByText(/vault sealed/)).toBeTruthy();
  });

  it("passes selected scopes through the OAuth flow", async () => {
    const created = makeConnection({ providerId: "linear" });
    createConnection.mockResolvedValue(created);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://linear.app/oauth/authorize",
    });
    awaitConsent.mockResolvedValue({ result: "active", connection: created });
    const scopedLinear = {
      ...catalog[1],
      scopes: [
        {
          name: "read",
          description: "Read issues",
          sensitive: false,
          default: true,
        },
        {
          name: "write",
          description: "Write issues",
          sensitive: true,
          default: false,
        },
      ],
    };
    listProviders.mockResolvedValue([scopedLinear]);
    // The bundled catalog paints first, so it must carry the scopes or the
    // form initializes without them.
    bundledRef.current = [scopedLinear];
    renderAt("/connections/linear");
    // Tick the non-default broad scope on.
    await userEvent.click(await screen.findByLabelText(/write/));
    await userEvent.click(
      screen.getByRole("button", { name: /Authorize with Linear/i }),
    );
    await waitFor(() =>
      expect(createConnection).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: ["read", "write"] }),
      ),
    );
  });

  it("shows an empty activity log in the identity graph", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    connectionEvents.mockResolvedValue([]);
    renderAt("/connections/github/con_1");
    await screen.findAllByText(/octocat/);
    expect(
      (await screen.findAllByText(/No events recorded/)).length,
    ).toBeGreaterThan(0);
  });

  it("shows the establishing note while identity connects", async () => {
    session.current = null;
    hostEligible.value = false;
    connectState.connecting = true;
    renderAt("/connections");
    expect(
      await screen.findByText(/Establishing your private session/),
    ).toBeTruthy();
  });

  it("offers vault and import doors on the connector page", async () => {
    renderAt("/connections/github");
    await screen.findByText(/Create GitHub App for this organization/);
    expect(
      screen.getByRole("link", { name: /Save a site login/i }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Import$/i })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Authorize on the Host/i }),
    ).toBeTruthy();
  });
});
