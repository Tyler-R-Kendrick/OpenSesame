/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { connectivityBarDependencies } from "../../components/ConnectivityBar.js";
import type { Connection, Provider } from "../../lib/connections.js";
import type { ConnectorStatus } from "../../lib/connectors.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import type { Folder, LoginItem, VaultItem } from "../../lib/vault/model.js";
import { vaultTreeSeams } from "../../sections/vault/VaultTree.js";

type VaultSnapshot = {
  items: VaultItem[];
  folders: Folder[];
  header: null;
  status: string;
};
type VaultFixture = { current: VaultSnapshot };
type ConnectorFixture = { current: ConnectorStatus[] };

const emptyVault: VaultSnapshot = {
  items: [],
  folders: [],
  header: null,
  status: "unlocked",
};

const vault: VaultFixture = { current: emptyVault };
const connectors: ConnectorFixture = { current: [] };
const noopStore = {
  purgeItem: () => undefined,
  trashItem: () => undefined,
  toggleFavorite: () => undefined,
};

Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => noopStore,
  useCopySecret: () => async () => "copied",
});
Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async (): Promise<void> => undefined,
});
Object.assign(connectivityBarDependencies, {
  useConnectors: () => connectors.current,
  checkNow: () => undefined,
});

import { ConnectivityBar } from "../../components/ConnectivityBar.js";
import { VaultSection } from "../../sections/VaultSection.js";
import { CatalogPanel } from "../../sections/connections/CatalogPanel.js";
import { ConnectedPanel } from "../../sections/connections/ConnectedPanel.js";
import { CoreConnectionsPanel } from "../../sections/settings/CoreConnectionsPanel.js";
import { HealthPanel } from "../../sections/vault/HealthPanel.js";
import {
  duplicateGuideTargetMounts,
  isMountedGuideTarget,
  resolveGuideTargetElement,
} from "./targets.js";

function provider(): Provider {
  return {
    id: "github",
    displayName: "GitHub",
    category: "developer",
    docsUrl: "https://example.invalid/docs",
    authKind: "oauth2_authorization_code",
    supportsRefresh: true,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: [],
  };
}

function connectorStatus(
  overrides: Partial<ConnectorStatus> = {},
): ConnectorStatus {
  return {
    id: "host",
    name: "Host",
    tone: "live",
    detail: "127.0.0.1:18787",
    failure: null,
    lastCheckedAt: null,
    checking: false,
    rttMs: null,
    ...overrides,
  };
}

function weakLogin(): LoginItem {
  return {
    id: "itm_1",
    kind: "login",
    name: "Somewhere",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    sample: false,
    username: "me@example.invalid",
    password: "abc",
    totp: "",
    uris: [],
    passwordChangedAt: "2026-08-01T00:00:00Z",
  };
}

function renderVault() {
  return render(
    <MemoryRouter initialEntries={["/vault"]}>
      <Routes>
        <Route path="/vault" element={<VaultSection />}>
          <Route index element={<div>welcome</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vault.current = emptyVault;
  connectors.current = [];
});

describe("instrumented screens", () => {
  /**
   * New item and Import each have two homes — the empty state and the list
   * header — and exactly one is ever on screen, so both share one binding.
   * This covers each home in turn: a second live binding would throw.
   */
  it("binds the vault list, its filters and both homes of the create action", () => {
    const empty = renderVault();
    expect(isMountedGuideTarget("vault.list")).toBe(true);
    expect(isMountedGuideTarget("vault.create")).toBe(true);
    expect(isMountedGuideTarget("vault.import")).toBe(true);
    expect(isMountedGuideTarget("vault.filter.favorites")).toBe(true);
    expect(isMountedGuideTarget("vault.health")).toBe(true);
    // Nothing to filter to yet.
    expect(isMountedGuideTarget("vault.filter.logins")).toBe(false);
    empty.unmount();

    vault.current = { ...emptyVault, items: [weakLogin()] };
    renderVault();
    expect(isMountedGuideTarget("vault.create")).toBe(true);
    expect(isMountedGuideTarget("vault.import")).toBe(true);
    expect(isMountedGuideTarget("vault.filter.logins")).toBe(true);
    expect(
      resolveGuideTargetElement("vault.create")?.getAttribute("href"),
    ).toBe("/vault/new/login");
  });

  it("binds the connector catalog, its search field and the custom-connector link", () => {
    const { container } = render(
      <MemoryRouter>
        <CatalogPanel providers={[provider()]} />
      </MemoryRouter>,
    );

    expect(isMountedGuideTarget("connections.catalog")).toBe(true);
    expect(isMountedGuideTarget("connections.provider-picker")).toBe(true);
    expect(isMountedGuideTarget("connections.custom")).toBe(true);

    expect(resolveGuideTargetElement("connections.provider-picker")).toBe(
      container.querySelector("input[type=search]"),
    );
    expect(resolveGuideTargetElement("connections.custom")?.textContent).toBe(
      "Custom connector",
    );
  });

  it("binds the connected panel", () => {
    const connections: Connection[] = [];
    render(
      <MemoryRouter>
        <ConnectedPanel
          connections={connections}
          providers={[]}
          loading={false}
          online
          onFlash={() => undefined}
          onChanged={() => undefined}
          onRememberOffer={() => undefined}
          setupRequired={false}
          hostConfigured
        />
      </MemoryRouter>,
    );

    expect(isMountedGuideTarget("connections.connected")).toBe(true);
    expect(resolveGuideTargetElement("connections.connected")?.tagName).toBe(
      "SECTION",
    );
  });

  it("binds the health verdict and its findings, and drops them on unmount", () => {
    vault.current = { ...emptyVault, items: [weakLogin()] };
    const view = render(
      <MemoryRouter>
        <HealthPanel />
      </MemoryRouter>,
    );

    expect(isMountedGuideTarget("vault.health.summary")).toBe(true);
    expect(isMountedGuideTarget("vault.health.findings")).toBe(true);

    view.unmount();
    expect(isMountedGuideTarget("vault.health.summary")).toBe(false);
    expect(isMountedGuideTarget("vault.health.findings")).toBe(false);
  });

  it("binds only the two authority planes on the statusline", () => {
    connectors.current = [
      connectorStatus(),
      connectorStatus({
        id: "identity",
        name: "Identity",
        detail: "signed in",
      }),
      connectorStatus({
        id: "keys",
        name: "Key vault",
        detail: "WebCrypto",
      }),
    ];
    render(
      <MemoryRouter>
        <ConnectivityBar />
      </MemoryRouter>,
    );

    expect(isMountedGuideTarget("connectivity.host")).toBe(true);
    expect(isMountedGuideTarget("connectivity.identity")).toBe(true);
    expect(
      resolveGuideTargetElement("connectivity.host")?.getAttribute(
        "aria-label",
      ),
    ).toBe("Host — 127.0.0.1:18787");
  });

  it("binds the core connections panel in Settings", () => {
    connectors.current = [connectorStatus()];
    render(
      <MemoryRouter>
        <CoreConnectionsPanel />
      </MemoryRouter>,
    );

    expect(isMountedGuideTarget("settings.core-connections")).toBe(true);
  });

  /**
   * Two live bindings for one id would let a guide highlight whichever the
   * registry happened to keep, so the instrumentation has to leave this list
   * empty across a whole suite of renders.
   */
  it("never mounts one semantic id twice across all of the above", () => {
    expect(duplicateGuideTargetMounts()).toEqual([]);
  });
});
