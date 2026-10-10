import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
/**
 * Moving from one connector page to another inside the one mounted section:
 * nothing provider A produced — a flash, a half-made connection, a typed
 * secret — may surface on provider B.
 */
/** @vitest-environment jsdom */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { embeddedCatalogSeams } from "@opensesame/app-core/lib/embedded-catalog.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vercelCatalogSeams } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
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
import { useOnlineSeams } from "../lib/use-online.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { ConnectionsSection } from "./ConnectionsSection.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./connections/connect/native-connector-integration.test-support.js";
import { CONNECTIONS_CATALOG as catalog } from "./connections/section-fixtures.test-support.js";
import { declareConnectionsTutorial } from "./connections/tutorial.test-support.js";

const startGithubAppRegistration = vi.fn();
const createConnection = vi.fn();
const setConnectionConfiguration = vi.fn();
const originalConnection = { ...connectionSeams };
const originalEmbedded = { ...embeddedCatalogSeams };
const originalVault = { ...vaultHooksSeams };
const originalOnline = { ...useOnlineSeams };
const originalIdentityHooks = { ...identityHookSeams };
const originalCatalog = vercelCatalogSeams.providers;

Object.assign(connectionSeams, {
  listConnections: vi.fn().mockResolvedValue([]),
  listIntegrations: vi.fn().mockResolvedValue([]),
  startGithubAppRegistration,
  createConnection,
  setConnectionConfiguration,
});
Object.assign(useOnlineSeams, { useOnline: () => true });
Object.assign(identityHookSeams, { useIdentitySession: () => null });
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], tomb: "guest", status: "unlocked" }),
});
Object.assign(embeddedCatalogSeams, {
  bundledProviders: catalog,
  readEmbeddedProviders: () => Promise.resolve(catalog),
  writeEmbeddedProviders: vi.fn().mockResolvedValue(undefined),
});
vercelCatalogSeams.providers = () => catalog;

afterAll(() => {
  Object.assign(connectionSeams, originalConnection);
  Object.assign(embeddedCatalogSeams, originalEmbedded);
  Object.assign(vaultHooksSeams, originalVault);
  Object.assign(useOnlineSeams, originalOnline);
  Object.assign(identityHookSeams, originalIdentityHooks);
  vercelCatalogSeams.providers = originalCatalog;
});

declareConnectionsTutorial();
installConnectorIntegration();

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {`go to ${to}`}
    </button>
  );
}

/** One `ConnectionsSection` element for every provider, as the app mounts it. */
function renderWithNavigation(path: string, others: string[]) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {others.map((to) => (
        <GoTo key={to} to={to} />
      ))}
      <Routes>
        <Route path="/connections" element={<ConnectionsSection />} />
        <Route
          path="/connections/:providerId"
          element={<ConnectionsSection />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, "", "/connections");
});

afterEach(() => {
  cleanup();
  clearNotices();
  vi.clearAllMocks();
});

describe("moving between connector pages", () => {
  it("does not carry provider A's error, or its bell notice, onto provider B", async () => {
    const fixture = connectorIntegration();
    fixture.replies.push({ status: 401, body: { message: "Bad credentials" } });
    renderWithNavigation("/connections/github", ["/connections/better-auth"]);
    await userEvent.type(
      await screen.findByLabelText("GitHub personal access token"),
      "private-browser-token",
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Verify and connect GitHub",
      }),
    );
    await screen.findAllByRole("img", {
      name: /Provider authorization was refused/,
    });
    await waitFor(() =>
      expect(listNotices()).toMatchObject([{ id: "connector:github" }]),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "go to /connections/better-auth" }),
    );
    await screen.findByRole("heading", { name: "Better Auth" });

    expect(
      screen.queryByRole("img", { name: /Provider authorization was refused/ }),
    ).toBeNull();
    expect(listNotices()).toEqual([]);
    expect(startGithubAppRegistration).not.toHaveBeenCalled();
  });

  it("does not bring A's error back when A is opened again", async () => {
    const fixture = connectorIntegration();
    fixture.replies.push({ status: 401, body: { message: "Bad credentials" } });
    renderWithNavigation("/connections/github", [
      "/connections/better-auth",
      "/connections/github",
    ]);
    await userEvent.type(
      await screen.findByLabelText("GitHub personal access token"),
      "private-browser-token",
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Verify and connect GitHub",
      }),
    );
    await screen.findAllByRole("img", {
      name: /Provider authorization was refused/,
    });
    await userEvent.click(
      screen.getByRole("button", { name: "go to /connections/better-auth" }),
    );
    await screen.findByRole("heading", { name: "Better Auth" });
    await userEvent.click(
      screen.getByRole("button", { name: "go to /connections/github" }),
    );
    await screen.findByRole("heading", { name: "GitHub" });
    expect(
      screen.queryByRole("img", { name: /Provider authorization was refused/ }),
    ).toBeNull();
    expect(
      screen.getByLabelText("GitHub personal access token"),
    ).toHaveProperty("value", "");
    expect(listNotices()).toEqual([]);
  });

  it("starts a supported provider's form empty after another provider verification failed", async () => {
    const fixture = connectorIntegration();
    const nativeCatalog = [
      ...catalog,
      integrationProvider("notion"),
      integrationProvider("openai"),
    ];
    embeddedCatalogSeams.bundledProviders = nativeCatalog;
    embeddedCatalogSeams.readEmbeddedProviders = async () => nativeCatalog;
    vercelCatalogSeams.providers = () => nativeCatalog;
    connectionSeams.listConnections = originalConnection.listConnections;
    fixture.replies.push({ body: { error: "invalid_key" }, status: 401 });
    renderWithNavigation("/connections/notion", ["/connections/openai"]);
    await screen.findByRole("heading", { name: "Notion" });
    await userEvent.click(screen.getByRole("radio", { name: "API Key" }));
    await userEvent.type(
      screen.getByLabelText("Notion API key"),
      "private-notion-key",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and connect Notion" }),
    );
    await waitFor(() => expect(fixture.requests).toHaveLength(1));
    await waitFor(() =>
      expect(listNotices()).toMatchObject([
        { id: "connector:notion", tone: "err" },
      ]),
    );
    expect(readDeviceRows()).toEqual([]);
    await userEvent.click(
      screen.getByRole("button", { name: "go to /connections/openai" }),
    );
    await screen.findByRole("heading", { name: "OpenAI" });
    expect(screen.getByLabelText("OpenAI API key")).toHaveProperty("value", "");
    expect(listNotices()).toEqual([]);
    fixture.replies.push({
      body: { data: [{ id: "gpt-4o-mini", object: "model" }] },
    });
    await userEvent.type(
      screen.getByLabelText("OpenAI API key"),
      "private-openai-key",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and connect OpenAI" }),
    );
    await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
    const row = readDeviceRows()[0];
    if (!row) throw new Error("Expected OpenAI saved connection");
    expect(row.providerId).toBe("openai");
    expect(readNativeConnector(row.connectionId)?.status).toBe("connected");
    expect(fixture.requests[1]?.headers.get("Authorization")).toBe(
      "Bearer private-openai-key",
    );
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      "private-notion-key",
    );
  });
});
