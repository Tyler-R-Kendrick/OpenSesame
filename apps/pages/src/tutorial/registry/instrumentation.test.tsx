/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import type { ConnectorStatus } from "@opensesame/app-core/lib/connectors.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import type { Folder, LoginItem, VaultItem } from "@opensesame/vault-core";
import { connectionCeremonyDependencies } from "../../components/ConnectionCeremony.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { IMPORT_COMMAND } from "../../modules/vault.interop-formats/runtime.js";
import { vaultTreeSeams } from "../../sections/vault/VaultTree.js";

// The connector surfaces bind targets the connectors capability declares,
// and Import is the formats capability's key in the vault path strip.
let revokeRealm = () => {};
let revokeImport = () => {};
beforeAll(() => {
  revokeRealm = registerTutorialRealm();
  revokeImport = registerContributionForTest("vault-command", IMPORT_COMMAND);
});
afterAll(() => {
  revokeRealm();
  revokeImport();
});

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
Object.assign(connectionCeremonyDependencies, {
  useConnectors: () => connectors.current,
  checkNow: () => undefined,
});

import {
  duplicateGuideTargetMounts,
  isKnownGuideTarget,
  isMountedGuideTarget,
  resolveGuideTargetElement,
} from "@opensesame/app-core/tutorial/registry/targets.js";
import { VaultSection } from "../../sections/VaultSection.js";
import { CatalogPanel } from "../../sections/connections/CatalogPanel.js";
import { ConnectedPanel } from "../../sections/connections/ConnectedPanel.js";
import { HealthPanel } from "../../sections/vault/HealthPanel.js";

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
    expect(isMountedGuideTarget("vault.export")).toBe(true);
    // The filter key is always there to point at; the roads themselves are
    // inside the sheet it opens, so they bind when it does and not before.
    expect(isMountedGuideTarget("vault.filter")).toBe(true);
    expect(isMountedGuideTarget("vault.filter.favorites")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^Filter — / }));
    expect(isMountedGuideTarget("vault.filter.favorites")).toBe(true);
    // Nothing to filter to yet.
    expect(isMountedGuideTarget("vault.filter.logins")).toBe(false);
    empty.unmount();

    vault.current = { ...emptyVault, items: [weakLogin()] };
    renderVault();
    expect(isMountedGuideTarget("vault.create")).toBe(true);
    expect(isMountedGuideTarget("vault.import")).toBe(true);
    expect(isMountedGuideTarget("vault.export")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Filter — / }));
    expect(isMountedGuideTarget("vault.filter.logins")).toBe(true);
    expect(
      resolveGuideTargetElement("vault.create")?.getAttribute("href"),
    ).toBe("/vault/new");
  });

  it("binds the connector catalog and its search field", () => {
    const { container } = render(
      <MemoryRouter>
        <CatalogPanel providers={[provider()]} />
      </MemoryRouter>,
    );

    expect(isMountedGuideTarget("connections.catalog")).toBe(true);
    expect(isMountedGuideTarget("connections.provider-picker")).toBe(true);

    expect(resolveGuideTargetElement("connections.provider-picker")).toBe(
      container.querySelector('button[title="Search (/)"]'),
    );
    // A custom connector was a form a Host took; with no Host there is no
    // key to point at and no page behind it (ADR 0151).
    expect(screen.queryByRole("link", { name: "Custom connector" })).toBeNull();
  });

  it("binds the connected panel", () => {
    const connections: Connection[] = [];
    render(
      <MemoryRouter>
        <ConnectedPanel
          connections={connections}
          providers={[]}
          loading={false}
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

  it("does not offer identity or key-vault glyphs as support targets", () => {
    expect(isKnownGuideTarget("connectivity.identity")).toBe(false);
    expect(isKnownGuideTarget("connectivity.host")).toBe(false);
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
