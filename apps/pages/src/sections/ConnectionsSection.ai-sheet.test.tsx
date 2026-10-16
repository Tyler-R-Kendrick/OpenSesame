import { probeAiConnection } from "@opensesame/app-core/lib/ai-connections/inference.js";
import { commitAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
/**
 * Saving a model provider's key closes the Add sheet and lands on the
 * Connections list (ADR 0192). The confirmation belongs to the page it lands
 * on: raised under the provider's own scope it would be dropped by the very
 * navigation the save causes.
 */
/** @vitest-environment jsdom */
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  embeddedCatalogSeams,
  getBundledProviders,
} from "@opensesame/app-core/lib/embedded-catalog.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { vercelCatalogSeams } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../bindings/identity.js";
import { useOnlineSeams } from "../lib/use-online.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { aiConnectionUiDependencies } from "./connections/ai/useAiConnection.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connections/connect/native-connector-integration.test-support.js";
import {
  CONNECTIONS_CATALOG,
  renderAt,
} from "./connections/section-fixtures.test-support.js";
import { declareConnectionsTutorial } from "./connections/tutorial.test-support.js";

const xai = getBundledProviders().find((row) => row.id === "xai");
if (!xai) throw new Error("the bundled catalog has no xAI row");
const catalog = [...CONNECTIONS_CATALOG, xai];
const originalConnection = { ...connectionSeams };
const originalEmbedded = { ...embeddedCatalogSeams };
const originalVault = { ...vaultHooksSeams };
const originalOnline = { ...useOnlineSeams };
const originalIdentity = { ...identityHookSeams };
const originalCatalog = vercelCatalogSeams.providers;

// The device's own connection list: what a save writes is what the page reads.
Object.assign(connectionSeams, { listIntegrations: async () => [] });
connectionSeams.listConnections = originalConnection.listConnections;
Object.assign(useOnlineSeams, { useOnline: () => true });
Object.assign(identityHookSeams, { useIdentitySession: () => null });
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], tomb: "guest", status: "unlocked" }),
});
Object.assign(embeddedCatalogSeams, {
  bundledProviders: catalog,
  readEmbeddedProviders: async () => catalog,
  writeEmbeddedProviders: vi.fn().mockResolvedValue(undefined),
});
vercelCatalogSeams.providers = () => catalog;

afterAll(() => {
  Object.assign(connectionSeams, originalConnection);
  Object.assign(embeddedCatalogSeams, originalEmbedded);
  Object.assign(vaultHooksSeams, originalVault);
  Object.assign(useOnlineSeams, originalOnline);
  Object.assign(identityHookSeams, originalIdentity);
  vercelCatalogSeams.providers = originalCatalog;
});
declareConnectionsTutorial();
installConnectorIntegration();
afterEach(() => {
  cleanup();
  clearNotices();
  window.history.replaceState({}, "", "/connections");
});

const SAVED = "AI connection verified and saved in this vault.";

describe("saving a model provider from its Add sheet", () => {
  it("confirms on the Connections list the save lands on", async () => {
    const fixture = connectorIntegration();
    vi.spyOn(aiConnectionUiDependencies, "save").mockImplementation(
      async (draft) => {
        const transport = {
          ...nativeProviderTransport(),
          signal: new AbortController().signal,
        };
        await probeAiConnection(draft, transport, transport.assertCurrent);
        return commitAiConnection(
          draft,
          "fixture-vault",
          "",
          transport.assertCurrent,
        );
      },
    );
    fixture.replies.push({
      body: { choices: [{ message: { content: "OK" } }] },
    });
    renderAt("/connections/xai");
    await screen.findByRole("dialog", { name: "Connect a model provider" });
    await userEvent.type(screen.getByLabelText("Model ID"), "fixture-model");
    await userEvent.type(
      screen.getByLabelText(/API key/i, { selector: 'input[type="password"]' }),
      "xai-private-key-0123456789",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save AI connection" }),
    );
    await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Connect a model provider" }),
      ).toBeNull(),
    );
    await screen.findByRole("heading", { name: "Connections" });
    expect(await screen.findByRole("img", { name: SAVED })).toBeTruthy();
    expect(fixture.requests[0]?.url).toBe(
      "https://api.x.ai/v1/chat/completions",
    );
    expect(fixture.requests[0]?.headers.get("Authorization")).toBe(
      "Bearer xai-private-key-0123456789",
    );
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      "xai-private-key-0123456789",
    );
    // a success is a quiet mark on the page, never a failure in the tray
    expect(listNotices()).toEqual([]);
  });
});
