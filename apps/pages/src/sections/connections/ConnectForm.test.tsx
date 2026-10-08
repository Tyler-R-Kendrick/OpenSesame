import { applyConnectCallbackBase } from "@opensesame/app-core/lib/connect-callback.js";
import {
  connectRoadSeams,
  notifyConnectRoads,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { localStore } from "@opensesame/app-core/ports.js";
import { hasConnectRoute } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { vercelConnectCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import {
  setVercelConnectAuth,
  usesConnect,
} from "@opensesame/app-core/lib/vercel-connect.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectForm } from "./ConnectForm.js";

const originalIntegrations = connectionSeams.listIntegrations;
const originalIdentity = { ...identitySeams };

/** A Host is named and this browser holds a live grant to it: it opens nothing. */
function nameAHostWithALiveGrant() {
  identitySeams.hostBase = () => "https://host.test";
  identitySeams.hostLocalSessionEligible = () => true;
}

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
  Object.assign(identitySeams, originalIdentity);
  resetConnectRoadSeams();
  notifyConnectRoads();
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
  connectRoadSeams.usesConnect = usesConnect;
  connectRoadSeams.hasConnectRoute = hasConnectRoute;
  notifyConnectRoads();
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

it("offers GitHub App registration and nothing a Host would take", async () => {
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
  // Each of these saved through a Host, which Pages does not speak to: a key
  // that could only fail is not drawn.
  expect(
    screen.queryByLabelText(/Or connect with a personal access token/i),
  ).toBeNull();
  expect(screen.queryByText(/Or use an existing OAuth app/i)).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Authorize with GitHub/i }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Save OAuth client/i }),
  ).toBeNull();
});

it("offers the same with a Host named and granted: it opens no road", async () => {
  nameAHostWithALiveGrant();
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
    screen.queryByLabelText(/Or connect with a personal access token/i),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Authorize with GitHub/i }),
  ).toBeNull();
  expect(screen.queryByLabelText(/Client ID/i)).toBeNull();
});

it("draws nothing to authorize once a local GitHub App is registered", async () => {
  nameAHostWithALiveGrant();
  localStore().setItem(
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
  // The App's own presence panel owns what follows; this form has no key left.
  expect(
    screen.queryByRole("button", {
      name: /Create GitHub App for this organization/i,
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Authorize with GitHub/i }),
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
