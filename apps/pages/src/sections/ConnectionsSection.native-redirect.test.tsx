/** @vitest-environment jsdom */
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { embeddedCatalogSeams } from "@opensesame/app-core/lib/embedded-catalog.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { settingsSeams } from "@opensesame/app-core/lib/settings.js";
import { vercelCatalogSeams } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { setVercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect.js";
import { cleanup, screen } from "@testing-library/react";
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
import { expectInTray } from "../components/tray.test-support.js";
import { useOnlineSeams } from "../lib/use-online.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connections/connect/native-connector-integration.test-support.js";
import {
  CONNECTIONS_CATALOG as catalog,
  makeConnection,
  renderAt,
} from "./connections/section-fixtures.test-support.js";
import { declareConnectionsTutorial } from "./connections/tutorial.test-support.js";

const originalConnections = { ...connectionSeams };
const originalEmbeddedCatalogSeams = { ...embeddedCatalogSeams };
const originalSettings = { ...settingsSeams };
const originalIdentity = { ...identityHookSeams };
const originalOnline = { ...useOnlineSeams };
const originalVault = { ...vaultHooksSeams };
const originalCatalog = { ...vercelCatalogSeams };
const online = { value: true };
const session = { current: { principalId: "prn_op" } };
const vault = { items: [], tomb: "personal", status: "unlocked" };
const shouldAutoConnect = vi.fn(() => true);
const listConnections = vi.fn();
const bundledRef = { current: catalog };
Object.assign(connectionSeams, {
  listConnections,
  listIntegrations: async () => [],
});
Object.assign(embeddedCatalogSeams, {
  readEmbeddedProviders: async () => bundledRef.current,
  writeEmbeddedProviders: async () => undefined,
});
Object.assign(identityHookSeams, { useIdentitySession: () => session.current });
Object.assign(useOnlineSeams, { useOnline: () => online.value });
Object.assign(vaultHooksSeams, { useVault: () => vault });
Object.assign(settingsSeams, { shouldAutoConnect });
vercelCatalogSeams.providers = () => bundledRef.current;
afterAll(() => {
  Object.assign(connectionSeams, originalConnections);
  Object.assign(embeddedCatalogSeams, originalEmbeddedCatalogSeams);
  Object.assign(settingsSeams, originalSettings);
  Object.assign(identityHookSeams, originalIdentity);
  Object.assign(useOnlineSeams, originalOnline);
  Object.assign(vaultHooksSeams, originalVault);
  Object.assign(vercelCatalogSeams, originalCatalog);
});
declareConnectionsTutorial();
installConnectorIntegration();

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

  it("does not interpret a legacy App error redirect as native token authorization", async () => {
    connectorIntegration();
    window.history.replaceState(
      {},
      "",
      "/connections/github?github_app=error&reason=denied",
    );
    renderAt("/connections/github");
    expect(
      await screen.findByLabelText("GitHub personal access token"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: /GitHub App registration failed/ }),
    ).toBeNull();
    expect(listNotices()).toEqual([]);
    expect(readDeviceRows()).toEqual([]);
  });

  it("does not interpret a legacy App success redirect as native token verification", async () => {
    connectorIntegration();
    window.history.replaceState(
      {},
      "",
      "/connections/github?github_app=registered",
    );
    renderAt("/connections/github");
    expect(
      await screen.findByLabelText("GitHub personal access token"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("img", {
        name: /GitHub App registered|GitHub App ready|Connected/,
      }),
    ).toBeNull();
    expect(readDeviceRows()).toEqual([]);
  });

  it("keeps native token verification available when a legacy App was registered from this browser", async () => {
    connectorIntegration();
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
      expect(
        await screen.findByLabelText("GitHub personal access token"),
      ).toBeTruthy();
      expect(screen.queryByTestId("github-app-presence")).toBeNull();
      expect(
        screen.queryByRole("img", { name: "GitHub App ready" }),
      ).toBeNull();
      expect(readDeviceRows()).toEqual([]);
      expect(
        screen.queryByRole("button", { name: /Authorize with GitHub/i }),
      ).toBeNull();
    } finally {
      localStorage.removeItem("opensesame.github-app.public");
    }
  });
});
