/**
 * The connector pages on a device with no Host (the static deployment): what a
 * person is offered, and what they are told when something they do fails.
 * Nothing here opens a Host road; that is the point.
 */
/** @vitest-environment jsdom */
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import { embeddedCatalogSeams } from "@opensesame/app-core/lib/embedded-catalog.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vercelCatalogSeams } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connections/connect/native-connector-integration.test-support.js";
import {
  CONNECTIONS_CATALOG as catalog,
  renderAt,
} from "./connections/section-fixtures.test-support.js";
import { declareConnectionsTutorial } from "./connections/tutorial.test-support.js";

const startGithubAppRegistration = vi.fn();
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

beforeEach(() => {
  window.history.replaceState({}, "", "/connections");
});

afterEach(() => {
  cleanup();
  clearNotices();
  vi.clearAllMocks();
});

describe("a connector page on a device with no Host", () => {
  it("explains why unsupported Better Auth cannot be configured in a browser", async () => {
    renderAt("/connections/better-auth");
    await screen.findByRole("heading", { name: "Better Auth" });
    expect(
      screen.queryByRole("button", {
        name: /Save configuration|Verify and connect/,
      }),
    ).toBeNull();
    expect(screen.queryByLabelText(/Base URL/)).toBeNull();
    expect(
      screen.getByText(/Better Auth has no supported browser driver/),
    ).toBeTruthy();
    expect(listNotices()).toEqual([]);
  });

  it("says a failure in the bell, and clears it on leaving the page", async () => {
    const fixture = connectorIntegration();
    fixture.replies.push({ status: 401, body: { message: "Bad credentials" } });
    const page = renderAt("/connections/github");
    await userEvent.type(
      await screen.findByLabelText("GitHub personal access token"),
      "private-browser-token",
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Verify and connect GitHub",
      }),
    );
    const refusal =
      "Provider authorization was refused; verify or replace the saved credential";
    expect(await screen.findAllByRole("img", { name: refusal })).toBeTruthy();
    await waitFor(() =>
      expect(listNotices()).toMatchObject([
        {
          id: "connector:github",
          tone: "err",
          title: "GitHub",
          body: refusal,
        },
      ]),
    );
    expect(startGithubAppRegistration).not.toHaveBeenCalled();
    expect(fixture.requests[0]?.url).toBe("https://api.github.com/user");
    page.unmount();
    expect(listNotices()).toEqual([]);
  });
});
