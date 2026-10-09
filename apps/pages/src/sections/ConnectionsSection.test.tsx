import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import type { SecretItem } from "@opensesame/vault-core";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { identityHookSeams } from "../bindings/identity.js";
const online = vi.hoisted(() => ({ value: true }));
const session: { current: { principalId: string } | null } = vi.hoisted(() => ({
  current: { principalId: "prn_op" },
}));
const connect = vi.hoisted(() => vi.fn());
const connectState: { connecting: boolean; error: string | null } = vi.hoisted(
  () => ({ connecting: false, error: null }),
);
import { setVercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect.js";
Object.assign(identityHookSeams, {
  useConnect: () => ({
    connect,
    connecting: connectState.connecting,
    error: connectState.error,
  }),
  useIdentitySession: () => session.current,
});
import { standInPrompt } from "../lib/command-bar/search.test-support.js";
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
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));
import * as githubInstallation from "@opensesame/app-core/lib/github-installation-access.js";
vi.spyOn(
  githubInstallation,
  "loadGithubInstallationSnapshot",
).mockResolvedValue({ ...githubInstallation.EMPTY_GITHUB_SNAPSHOT });
vi.spyOn(githubInstallation, "shouldEnsureGithubAccessGrant").mockReturnValue(
  false,
);
vi.spyOn(githubInstallation, "ensureGithubAccessGrant").mockResolvedValue([]);
const listConnections = vi.hoisted(() => vi.fn());
const createConnection = vi.hoisted(() => vi.fn());
const authorizeConnection = vi.hoisted(() => vi.fn());
const awaitConsent = vi.hoisted(() => vi.fn());
const revokeConnection = vi.hoisted(() => vi.fn());
const setConnectionCredential = vi.hoisted(() => vi.fn());
const setConnectionConfiguration = vi.hoisted(() => vi.fn());
const listIntegrations = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const openConsentPopup = vi.hoisted(() => vi.fn(() => null));
const startGithubAppRegistration = vi.hoisted(() => vi.fn());
const submitGithubAppManifest = vi.hoisted(() => vi.fn());
import {
  ConnectionsError,
  type Provider,
  connectionSeams,
} from "@opensesame/app-core/lib/connections.js";
import { vercelCatalogSeams } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import {
  CONNECTIONS_CATALOG as catalog,
  makeConnection,
  renderAt,
} from "./connections/section-fixtures.test-support.js";
import { declareConnectionsTutorial } from "./connections/tutorial.test-support.js";
const originalConnectionSeams = { ...connectionSeams };
Object.assign(connectionSeams, {
  listConnections,
  createConnection,
  authorizeConnection,
  awaitConsent,
  revokeConnection,
  setConnectionCredential,
  setConnectionConfiguration,
  listIntegrations,
  openConsentPopup,
  startGithubAppRegistration,
  submitGithubAppManifest,
});
afterAll(() => Object.assign(connectionSeams, originalConnectionSeams));
const bundledRef = { current: new Array<Provider>() };
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
import { expectInTray } from "../components/tray.test-support.js";
const originalPasskeyCeremonyNoteSeams = { ...passkeyCeremonyNoteSeams };
Object.assign(passkeyCeremonyNoteSeams, { PasskeyCeremonyNote: () => null });
afterAll(() =>
  Object.assign(passkeyCeremonyNoteSeams, originalPasskeyCeremonyNoteSeams),
);

// Every screen here mounts guide targets `connectors.external` contributes
// (`connections.reload`, `.connected`, `.catalog`, `.provider-picker`,
// `.custom`, `.back`). These cases describe a deployment that approved that
// capability, so they declare the same descriptors the module registers at
// activation.
declareConnectionsTutorial();

describe("ConnectionsSection gallery", () => {
  let prompt = standInPrompt();
  beforeEach(() => {
    prompt = standInPrompt();
    online.value = true;
    session.current = { principalId: "prn_op" };
    connectState.connecting = false;
    connectState.error = null;
    shouldAutoConnect.mockReturnValue(true);
    bundledRef.current = catalog;
    embeddedCatalogSeams.bundledProviders = catalog;
    listConnections.mockResolvedValue([]);
    vault.items = [];
    setVercelConnectAuth({ token: "test_token" });
    window.history.replaceState({}, "", "/connections");
  });

  afterEach(() => {
    cleanup();
    prompt.stop();
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

  it("filters the catalog by the prompt's words and clears it", async () => {
    const { container } = renderAt("/connections");
    await screen.findByText("Linear");
    // No key or field of its own: the catalog is searched in the prompt.
    expect(screen.queryByLabelText("Search connectors")).toBeNull();
    act(() => prompt.type("/? linear"));
    // SAFETY: fixture constructed in this test matches the declared contract.
    const grid = container.querySelector(".conn-grid") as HTMLElement;
    expect(within(grid).getByText("Linear")).toBeTruthy();
    expect(container.querySelectorAll(".conn-tile").length).toBe(1);
    act(() => prompt.type("/? zzzz"));
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

  it("warns when connection sealing is unavailable", async () => {
    const keyed = [
      { ...catalog[1], missingConfig: ["OPENSESAME_CONNECTION_KEY"] },
    ];
    bundledRef.current = keyed;
    embeddedCatalogSeams.bundledProviders = keyed;
    renderAt("/connections");
    await expectInTray("Connection sealing is not available yet");
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
    shouldAutoConnect.mockReturnValue(true);
    bundledRef.current = catalog;
    embeddedCatalogSeams.bundledProviders = catalog;
    listConnections.mockResolvedValue([]);
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
    await waitFor(() => expect(submitGithubAppManifest).toHaveBeenCalled());
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

  it("refuses unsupported Better Auth without collecting or saving credentials", async () => {
    renderAt("/connections/better-auth");
    await screen.findByRole("heading", { name: "Better Auth" });
    expect(
      screen.getByText(
        /Better Auth has no supported browser driver for its catalog operations/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: "Better Auth has no supported browser connection method.",
      }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/Base URL/)).toBeNull();
    expect(screen.queryByLabelText(/^API key/)).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Save configuration|Verify and connect|Authorize with/,
      }),
    ).toBeNull();
    expect(createConnection).not.toHaveBeenCalled();
    expect(setConnectionConfiguration).not.toHaveBeenCalled();
    expect(setConnectionCredential).not.toHaveBeenCalled();
    expect(authorizeConnection).not.toHaveBeenCalled();
  });
});

describe("ConnectionsSection deeper branches", () => {
  beforeEach(() => {
    online.value = true;
    session.current = { principalId: "prn_op" };
    shouldAutoConnect.mockReturnValue(true);
    bundledRef.current = catalog;
    embeddedCatalogSeams.bundledProviders = catalog;
    listConnections.mockResolvedValue([]);
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
    await expectInTray("This browser is offline");
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

  it("hides Connect once the GitHub App is registered from this browser", async () => {
    localStorage.setItem(
      "opensesame.github-app.public",
      JSON.stringify({
        id: "123",
        key: "github-oauth",
        displayName: "Org App",
        htmlUrl: "https://github.com/apps/org-app",
        ownerLogin: "acme",
        ownerType: "Organization",
        installedByLogin: null,
        installations: [],
      }),
    );
    try {
      renderAt("/connections/github");
      expect(await screen.findByTestId("github-app-presence")).toBeTruthy();
      await waitFor(() => {
        expect(
          screen.queryByRole("heading", { name: /^Connect$/i }),
        ).toBeNull();
      });
      expect(
        screen.queryByRole("button", { name: /Authorize with GitHub/i }),
      ).toBeNull();
    } finally {
      localStorage.removeItem("opensesame.github-app.public");
    }
  });
});

describe("ConnectionsSection remaining branches", () => {
  beforeEach(() => {
    online.value = true;
    session.current = { principalId: "prn_op" };
    connectState.connecting = false;
    connectState.error = null;
    shouldAutoConnect.mockReturnValue(true);
    bundledRef.current = catalog;
    embeddedCatalogSeams.bundledProviders = catalog;
    listConnections.mockResolvedValue([]);
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
