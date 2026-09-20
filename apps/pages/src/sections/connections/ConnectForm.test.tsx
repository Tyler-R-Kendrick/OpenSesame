/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { applyConnectCallbackBase } from "../../lib/connect-callback.js";
import type { Provider } from "../../lib/connections.js";
import { connectionSeams } from "../../lib/connections.js";
import { vercelConnectCatalog } from "../../lib/vercel-connect-catalog.js";
import { setVercelConnectAuth } from "../../lib/vercel-connect.js";
import { ConnectForm } from "./ConnectForm.js";

const originalIntegrations = connectionSeams.listIntegrations;

afterEach(() => {
  cleanup();
  setVercelConnectAuth(null);
  applyConnectCallbackBase("");
  connectionSeams.listIntegrations = originalIntegrations;
});

function slackProvider(): Provider {
  const found = vercelConnectCatalog().find((row) => row.id === "slack");
  if (!found) throw new Error("slack missing from the Vercel catalog");
  return found;
}

function githubProvider(): Provider {
  return {
    id: "github",
    displayName: "GitHub",
    category: "backup_recovery",
    docsUrl: "https://docs.github.com/apps",
    authKind: "oauth2_authorization_code",
    supportsRefresh: false,
    configured: false,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    operations: ["contents.write"],
  };
}

it("authorizes a Connect-managed provider through the relay", () => {
  applyConnectCallbackBase("http://127.0.0.1:8789");
  render(
    <ConnectForm
      provider={slackProvider()}
      online
      onFlash={vi.fn()}
      onConnected={vi.fn()}
    />,
  );
  const authorize = screen.getByRole("button", {
    name: "Authorize with Slack",
  });
  expect(authorize instanceof HTMLButtonElement && !authorize.disabled).toBe(
    true,
  );
});

it("offers GitHub App registration instead of Connect for GitHub", async () => {
  connectionSeams.listIntegrations = vi.fn(async () => []);
  render(
    <ConnectForm
      provider={githubProvider()}
      online
      onFlash={vi.fn()}
      onConnected={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("button", {
      name: /Create GitHub App for this organization/i,
    }),
  ).toBeTruthy();
  expect(screen.queryByText(/Connect relay/i)).toBeNull();
});
