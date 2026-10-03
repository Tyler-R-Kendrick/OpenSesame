/**
 * Moving from one connector page to another inside the one mounted section:
 * nothing provider A produced — a flash, a half-made connection, a typed
 * secret — may surface on provider B.
 */
/** @vitest-environment jsdom */
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import { embeddedCatalogSeams } from "@opensesame/app-core/lib/embedded-catalog.js";
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
  CONNECTIONS_CATALOG as catalog,
  makeConnection,
} from "./connections/section-fixtures.test-support.js";
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
    startGithubAppRegistration.mockRejectedValue(
      new Error("GitHub refused the manifest."),
    );
    renderWithNavigation("/connections/github", ["/connections/better-auth"]);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Create GitHub App for this organization/i,
      }),
    );
    await screen.findByRole("img", { name: "GitHub refused the manifest." });
    await waitFor(() =>
      expect(listNotices()).toMatchObject([{ id: "connector:github" }]),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "go to /connections/better-auth" }),
    );
    await screen.findByRole("heading", { name: "Better Auth" });

    expect(
      screen.queryByRole("img", { name: "GitHub refused the manifest." }),
    ).toBeNull();
    expect(listNotices()).toEqual([]);
  });

  it("does not bring A's error back when A is opened again", async () => {
    startGithubAppRegistration.mockRejectedValue(
      new Error("GitHub refused the manifest."),
    );
    renderWithNavigation("/connections/github", [
      "/connections/better-auth",
      "/connections/github",
    ]);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Create GitHub App for this organization/i,
      }),
    );
    await screen.findByRole("img", { name: "GitHub refused the manifest." });
    await userEvent.click(
      screen.getByRole("button", { name: "go to /connections/better-auth" }),
    );
    await screen.findByRole("heading", { name: "Better Auth" });
    await userEvent.click(
      screen.getByRole("button", { name: "go to /connections/github" }),
    );
    await screen.findByRole("heading", { name: "GitHub" });
    expect(
      screen.queryByRole("img", { name: "GitHub refused the manifest." }),
    ).toBeNull();
    expect(listNotices()).toEqual([]);
  });

  it("starts provider B's form empty and makes B its own connection after A's save failed", async () => {
    createConnection.mockImplementation(async (input: { providerId: string }) =>
      makeConnection({
        connectionId: `con_${input.providerId}`,
        providerId: input.providerId,
      }),
    );
    setConnectionConfiguration.mockRejectedValueOnce(
      new Error("Vaultwarden said no."),
    );
    renderWithNavigation("/connections/vaultwarden", [
      "/connections/better-auth",
    ]);
    await userEvent.type(
      await screen.findByLabelText(/Server URL/),
      "https://vw.example.com",
    );
    await userEvent.type(screen.getByLabelText(/^API key/), "vw-secret-value");
    await userEvent.click(
      screen.getByRole("button", { name: /Save configuration/ }),
    );
    await waitFor(() =>
      expect(setConnectionConfiguration).toHaveBeenCalledWith(
        "con_vaultwarden",
        expect.anything(),
      ),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "go to /connections/better-auth" }),
    );
    await screen.findByRole("heading", { name: "Better Auth" });

    const apiKey = screen.getByLabelText(/^API key \(required\)/);
    expect(apiKey).toHaveProperty("value", "");
    expect(screen.getByLabelText(/Base URL/)).toHaveProperty("value", "");

    await userEvent.type(screen.getByLabelText(/Base URL/), "https://ba.test");
    await userEvent.type(apiKey, "ba-secret-value");
    await userEvent.click(
      screen.getByRole("button", { name: /Save configuration/ }),
    );
    await waitFor(() =>
      expect(setConnectionConfiguration).toHaveBeenCalledTimes(2),
    );
    expect(createConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerId: "better-auth" }),
    );
    expect(setConnectionConfiguration).toHaveBeenLastCalledWith(
      "con_better-auth",
      expect.anything(),
    );
  });
});
