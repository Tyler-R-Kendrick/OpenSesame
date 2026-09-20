/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyConnectCallbackBase } from "../../lib/connect-callback.js";
import type { Provider } from "../../lib/connections.js";
import { connectionSeams } from "../../lib/connections.js";
import { vercelConnectCatalog } from "../../lib/vercel-connect-catalog.js";
import { setVercelConnectAuth } from "../../lib/vercel-connect.js";
import { ConnectForm } from "./ConnectForm.js";

const originalIntegrations = connectionSeams.listIntegrations;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
});

afterEach(() => {
  cleanup();
  setVercelConnectAuth(null);
  applyConnectCallbackBase("");
  connectionSeams.listIntegrations = originalIntegrations;
  vi.unstubAllGlobals();
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
  expect(
    screen.getByLabelText(/Or connect with a personal access token/i),
  ).toBeTruthy();
  expect(screen.queryByText(/Connect relay/i)).toBeNull();
});

it("hides Create App and PAT once a local GitHub App is registered", async () => {
  connectionSeams.listIntegrations = vi.fn(async () => []);
  localStorage.setItem(
    "opensesame.github-app.public",
    JSON.stringify({
      id: "123",
      key: "github-oauth",
      displayName: "OpenSesame",
      htmlUrl: "https://github.com/apps/opensesame",
      ownerLogin: "acme",
      ownerType: "User",
      installedByLogin: null,
      installations: [],
    }),
  );
  render(
    <ConnectForm
      provider={githubProvider()}
      online
      onFlash={vi.fn()}
      onConnected={vi.fn()}
    />,
  );
  await screen.findByRole("button", {
    name: /Authorize with GitHub/i,
  });
  expect(
    screen.queryByRole("button", {
      name: /Create GitHub App for this organization/i,
    }),
  ).toBeNull();
  expect(
    screen.queryByLabelText(/Or connect with a personal access token/i),
  ).toBeNull();
  expect(screen.queryByLabelText(/Client ID/i)).toBeNull();
  expect(screen.queryByText(/Optional settings/i)).toBeNull();
  expect(
    screen.queryByRole("link", { name: /Install GitHub App on an account/i }),
  ).toBeNull();
});

it("hides Create App and PAT when the provider is already configured", () => {
  connectionSeams.listIntegrations = vi.fn(async () => []);
  render(
    <ConnectForm
      provider={{ ...githubProvider(), configured: true }}
      online
      onFlash={vi.fn()}
      onConnected={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", {
      name: /Create GitHub App for this organization/i,
    }),
  ).toBeNull();
  expect(
    screen.queryByLabelText(/Or connect with a personal access token/i),
  ).toBeNull();
  expect(screen.queryByText(/Optional settings/i)).toBeNull();
  expect(
    screen.queryByRole("link", { name: /Install GitHub App on an account/i }),
  ).toBeNull();
});
