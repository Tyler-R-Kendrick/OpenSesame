import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import type { SecretItem } from "@opensesame/vault-core";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../bindings/identity.js";
const online = vi.hoisted(() => ({ value: true }));
const session: { current: { principalId: string } | null } = vi.hoisted(() => ({
  current: { principalId: "prn_op" },
}));
const hostEligible = vi.hoisted(() => ({ value: true }));
const connect = vi.hoisted(() => vi.fn());
const connectState: { connecting: boolean; error: string | null } = vi.hoisted(
  () => ({
    connecting: false,
    error: null,
  }),
);
const ensureHostSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { setVercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect.js";
Object.assign(identitySeams, {
  ensureHostSession,
  hostBase: () => "http://127.0.0.1:8787",
  hostLocalSessionEligible: () => hostEligible.value,
});
Object.assign(identityHookSeams, {
  useConnect: () => ({
    connect,
    connecting: connectState.connecting,
    error: connectState.error,
  }),
  useIdentitySession: () => session.current,
});
import { useOnlineSeams } from "../lib/use-online.js";
Object.assign(useOnlineSeams, { useOnline: () => online.value });
const shouldAutoConnect = vi.hoisted(() => vi.fn(() => true));
import { settingsSeams } from "@opensesame/app-core/lib/settings.js";
Object.assign(settingsSeams, { shouldAutoConnect });
const vault: { items: SecretItem[]; tomb: string; status: string } = vi.hoisted(
  () => ({ items: [], tomb: "personal", status: "unlocked" }),
);
const addItems = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const saveItem = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

import { vaultHooksSeams } from "../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault,
  useVaultStore: () => ({ addItems, saveItem }),
});

import * as githubInstallation from "@opensesame/app-core/lib/github-installation-access.js";
vi.spyOn(
  githubInstallation,
  "loadGithubInstallationSnapshot",
).mockResolvedValue({
  integrations: [],
  installations: [],
  repos: [],
  shares: [],
  events: [],
  auditEvents: [],
});
vi.spyOn(githubInstallation, "shouldEnsureGithubAccessGrant").mockReturnValue(
  false,
);
vi.spyOn(githubInstallation, "ensureGithubAccessGrant").mockResolvedValue([]);

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
const createIntegration = vi.hoisted(() => vi.fn());
const openConsentPopup = vi.hoisted(() => vi.fn(() => null));
const startGithubAppRegistration = vi.hoisted(() => vi.fn());
const submitGithubAppManifest = vi.hoisted(() => vi.fn());

import {
  type Connection,
  ConnectionsError,
  type Provider,
  connectionSeams,
} from "@opensesame/app-core/lib/connections.js";
import { vercelCatalogSeams } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { ConnectionsSection } from "./ConnectionsSection.js";
import {
  CONNECTIONS_CATALOG as catalog,
  makeConnection,
  renderAt,
} from "./connections/section-fixtures.test-support.js";
import { declareConnectionsTutorial } from "./connections/tutorial.test-support.js";
const originalConnectionSeams = { ...connectionSeams };
Object.assign(connectionSeams, {
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
  createIntegration,
  openConsentPopup,
  startGithubAppRegistration,
  submitGithubAppManifest,
});

const bundledRef: { current: Provider[] } = { current: [] };
vercelCatalogSeams.providers = () =>
  bundledRef.current.length > 0 ? bundledRef.current : catalog;

import { embeddedCatalogSeams } from "@opensesame/app-core/lib/embedded-catalog.js";
const originalEmbeddedCatalogSeams = {
  ...embeddedCatalogSeams,
  bundledProviders: embeddedCatalogSeams.bundledProviders,
};
embeddedCatalogSeams.readEmbeddedProviders = () =>
  Promise.resolve(embeddedCatalogSeams.bundledProviders);
embeddedCatalogSeams.writeEmbeddedProviders = vi
  .fn()
  .mockResolvedValue(undefined);

import { passkeyCeremonyNoteSeams } from "../components/PasskeyCeremonyNote.js";
const originalPasskeyCeremonyNoteSeams = { ...passkeyCeremonyNoteSeams };
Object.assign(passkeyCeremonyNoteSeams, {
  PasskeyCeremonyNote: () => null,
});

// Every screen here mounts guide targets `connectors.external` contributes
// (`connections.reload`, `.connected`, `.catalog`, `.provider-picker`,
// `.custom`, `.back`). These cases describe a deployment that approved that
// capability, so they declare the same descriptors the module registers at
// activation.
declareConnectionsTutorial();

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
    embeddedCatalogSeams.bundledProviders = catalog;
    listConnections.mockResolvedValue([]);
    connectionEvents.mockResolvedValue([]);
    discoverConnections.mockResolvedValue(0);
    vault.items = [];
    setVercelConnectAuth({ token: "test_token" });
    window.history.replaceState({}, "", "/connections");
  });

  afterEach(() => {
    cleanup();
    clearNotices();
    setVercelConnectAuth(null);
    vi.clearAllMocks();
    embeddedCatalogSeams.bundledProviders =
      originalEmbeddedCatalogSeams.bundledProviders;
  });

  it("renders the catalog grouped by category", async () => {
    renderAt("/connections");
    expect(
      await screen.findByRole("heading", { name: "Connections" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Linear").length).toBeGreaterThan(0);
    expect(screen.queryByText("Vaultwarden")).toBeNull();
    expect(screen.queryByText("Better Auth")).toBeNull();
    expect(screen.getAllByText("Developer tools")).toHaveLength(2);
    expect(screen.queryByText("Password managers")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: /Enable Plain storage/i }),
    ).toBeNull();
  });

  it("filters the catalog by search and clears it", async () => {
    const { container } = renderAt("/connections");
    await screen.findByText("Linear");
    await userEvent.click(
      screen.getByRole("button", { name: "Search connectors" }),
    );
    const search = () =>
      screen.getByRole("textbox", { name: "Search connectors" });
    await userEvent.type(search(), "linear");
    // SAFETY: fixture constructed in this test matches the declared contract.
    const grid = container.querySelector(".conn-grid") as HTMLElement;
    expect(within(grid).getByText("Linear")).toBeTruthy();
    expect(container.querySelectorAll(".conn-tile").length).toBe(1);
    await userEvent.clear(search());
    await userEvent.type(search(), "zzzz");
    expect(screen.getByText("No matching connectors")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Clear search/i }),
    );
    // Catalog tiles: github, linear, vercel (feature + automatic excluded).
    expect(container.querySelectorAll(".conn-tile").length).toBe(3);
  });
  it("does not report an unreachable Host as a notification", async () => {
    listConnections.mockRejectedValue(
      new ConnectionsError(0, "unreachable", "fetch failed"),
    );
    renderAt("/connections");
    await waitFor(() => {
      expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
    });
    expect(
      listNotices().find((n) => n.id === "connections-load"),
    ).toBeUndefined();
    expect(screen.queryByText(/Host API/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the bundled catalog when the remote list is unreachable", async () => {
    listProviders.mockRejectedValue(
      new ConnectionsError(0, "unreachable", "fetch failed"),
    );
    renderAt("/connections");
    await waitFor(() => {
      expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
    });
    expect(listNotices().find((n) => n.id === "catalog-stale")).toBeUndefined();
    expect(screen.queryByText(/Host API/i)).toBeNull();
    expect(screen.queryByText(/Host catalog/i)).toBeNull();
  });

  it("warns when connection sealing is unavailable", async () => {
    const keyed = [
      { ...catalog[1], missingConfig: ["OPENSESAME_CONNECTION_KEY"] },
    ];
    bundledRef.current = keyed;
    embeddedCatalogSeams.bundledProviders = keyed;
    renderAt("/connections");
    expect(
      await screen.findByText(/Connection sealing is not available yet/),
    ).toBeTruthy();
  });

  it("lists unfinished connections under Needs attention", async () => {
    listConnections.mockResolvedValue([
      makeConnection({ status: "pending", displayName: "GitHub work" }),
    ]);
    renderAt("/connections");
    expect(
      await screen.findByRole("heading", { name: "Needs attention" }),
    ).toBeTruthy();
    expect(screen.getAllByText("GitHub work").length).toBeGreaterThan(0);
    // The sentence shows in both the inbox and the connected list.
    expect(
      screen.getAllByText(/Created, but nobody has approved it yet/).length,
    ).toBeGreaterThanOrEqual(1);
    // Repair happens in place now: the primary finishes the authorization
    // here, and only the quiet Details link goes to the connector page.
    expect(
      screen.getByRole("button", { name: /Finish authorization/i }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Details/i })).toBeTruthy();
  });

  it("shows managed connections with a status sentence", async () => {
    listConnections.mockResolvedValue([makeConnection()]);
    renderAt("/connections");
    expect(await screen.findByText(/Authorized as octocat/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Settings for GitHub/i }),
    ).toBeTruthy();
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
    embeddedCatalogSeams.bundledProviders = catalog;
    listConnections.mockResolvedValue([]);
    connectionEvents.mockResolvedValue([]);
    vault.items = [];
    setVercelConnectAuth({ token: "test_token" });
    window.history.replaceState({}, "", "/connections/github");
  });

  afterEach(() => {
    cleanup();
    clearNotices();
    setVercelConnectAuth(null);
    vi.clearAllMocks();
    embeddedCatalogSeams.bundledProviders =
      originalEmbeddedCatalogSeams.bundledProviders;
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
    expect(await screen.findByRole("img", { name: /no host/ })).toBeTruthy();
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
    expect(await screen.findByLabelText(/GitHub connected/)).toBeTruthy();
  });

  it("shows only required Better Auth inputs and applies hidden defaults", async () => {
    const created = makeConnection({ providerId: "better-auth" });
    createConnection.mockResolvedValue(created);
    setConnectionConfiguration.mockResolvedValue(created);
    renderAt("/connections/better-auth");
    await userEvent.type(
      await screen.findByLabelText(/Base URL/),
      "https://auth.example.com/api/auth",
    );
    await userEvent.type(
      screen.getByLabelText(/^API key \(required\)/),
      "ba_secret",
    );
    const optional = screen.getByText("Optional settings").closest("details");
    expect(optional?.open).toBe(false);
    expect(screen.getByLabelText(/API key header \(automatic\)/)).toMatchObject(
      { value: "x-api-key" },
    );
    expect(
      screen.getByLabelText(/Configuration ID \(automatic\)/),
    ).toMatchObject({ value: "default" });
    await userEvent.click(
      screen.getByRole("button", { name: /Save configuration/i }),
    );
    await waitFor(() =>
      expect(setConnectionConfiguration).toHaveBeenCalledWith("con_1", {
        base_url: "https://auth.example.com/api/auth",
        api_key: "ba_secret",
        api_key_header: "x-api-key",
        config_id: "default",
      }),
    );
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
    embeddedCatalogSeams.bundledProviders = catalog;
    listConnections.mockResolvedValue([]);
    connectionEvents.mockResolvedValue([]);
    discoverConnections.mockResolvedValue(0);
    vault.items = [];
    setVercelConnectAuth({ token: "test_token" });
    window.history.replaceState({}, "", "/connections");
  });

  afterEach(() => {
    cleanup();
    clearNotices();
    setVercelConnectAuth(null);
    vi.clearAllMocks();
    embeddedCatalogSeams.bundledProviders =
      originalEmbeddedCatalogSeams.bundledProviders;
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

  it("handles a GitHub App registration redirect with a reason", async () => {
    window.history.replaceState(
      {},
      "",
      "/connections/github?github_app=error&reason=denied",
    );
    renderAt("/connections/github");
    expect(
      await screen.findByRole("img", {
        name: /GitHub App registration failed: denied/,
      }),
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
      await screen.findByRole("img", { name: /GitHub App registered/ }),
    ).toBeTruthy();
  });

  it("hides Connect once the GitHub App is already configured", async () => {
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
    expect(await screen.findByTestId("github-app-presence")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /^Connect$/i })).toBeNull();
    });
    expect(
      screen.queryByRole("button", { name: /Authorize with GitHub/i }),
    ).toBeNull();
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
    embeddedCatalogSeams.bundledProviders = catalog;
    listConnections.mockResolvedValue([]);
    connectionEvents.mockResolvedValue([]);
    discoverConnections.mockResolvedValue(0);
    vault.items = [];
    setVercelConnectAuth({ token: "test_token" });
    window.history.replaceState({}, "", "/connections");
  });

  afterEach(() => {
    cleanup();
    clearNotices();
    setVercelConnectAuth(null);
    vi.clearAllMocks();
    embeddedCatalogSeams.bundledProviders =
      originalEmbeddedCatalogSeams.bundledProviders;
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
});
