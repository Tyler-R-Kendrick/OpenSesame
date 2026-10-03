/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { double } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  getConnection,
  listConnections,
} from "@opensesame/app-core/lib/connections.js";
import {
  forgetDeviceConnectors,
  renderedConnectorRecord,
} from "@opensesame/app-core/lib/device-connectors.js";
import { isGitBackupProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import { forgetAllLocalGitRemotes } from "@opensesame/app-core/lib/git-remote-local.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapabilityFeature } from "../../lib/capability-feature-operation.js";
import {
  installPanelFixture,
  openConnectorPages,
  renderPanel,
} from "./capabilities-panel.test-support.js";
import {
  displayName,
  expectedPublic,
  expectedSecrets,
  listedProviders,
  saveListed,
  selectedScopes,
} from "./capability-connector-harness.js";

installDoublePorts();
installPanelFixture();

const originalIdentity = { ...identitySeams };

async function reload(provider: Provider, connectionId: string) {
  if (isGitBackupProvider(provider.id)) {
    const rows = await listConnections();
    const found = rows.find((row) => row.connectionId === connectionId);
    if (!found) throw new Error(`reload missed ${provider.id}`);
    return found;
  }
  return getConnection(connectionId);
}

describe("capability connectors the page lists", () => {
  beforeEach(async () => {
    identitySeams.hostBase = () => "";
    identitySeams.hostLocalSessionEligible = () => false;
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(true);
    vi.spyOn(vaultStore, "addItems").mockResolvedValue(undefined);
    vi.spyOn(vaultStore, "trashItem").mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    await forgetAllLocalGitRemotes();
    forgetDeviceConnectors();
  });

  afterEach(() => {
    Object.assign(identitySeams, originalIdentity);
    vi.restoreAllMocks();
  });

  it("saves every listed connector and the feature operation uses that configuration", async () => {
    const listed = listedProviders();
    expect(listed.map((provider) => provider.id)).toContain("anthropic");
    expect(listed.map((provider) => provider.id)).toContain("tailscale");
    expect(listed.some((provider) => provider.authKind === "api_key")).toBe(
      true,
    );
    expect(
      listed.some((provider) => provider.authKind === "configuration"),
    ).toBe(true);
    const covered: string[] = [];
    for (const provider of listed) {
      expect(
        runCapabilityFeature(provider).ok,
        `${provider.id} ${provider.category}`,
      ).toBe(false);
      const saved = await saveListed(provider);
      const connection = await reload(provider, saved.connectionId);
      const rendered = renderedConnectorRecord(connection);
      const packed = JSON.stringify(rendered);
      const secrets = expectedSecrets(provider);
      for (const value of Object.values(secrets)) {
        expect(packed, provider.id).not.toContain(value);
      }
      const run = runCapabilityFeature(provider);
      expect(run.ok, `${provider.id} ${provider.category}`).toBe(true);
      if (!run.ok) continue;
      const action = JSON.stringify(run.action);
      for (const value of Object.values(secrets)) {
        expect(action, provider.id).not.toContain(value);
      }
      expect(run.secrets, provider.id).toEqual(secrets);
      expect(run.action, provider.id).toMatchObject(expectedPublic(provider));
      expect(run.operation, provider.id).toBe(
        provider.operations[0] ?? "configure",
      );
      expect(rendered.connection.displayName, provider.id).toBe(
        displayName(provider),
      );
      expect(rendered.publicFields, provider.id).toEqual(
        expectedPublic(provider),
      );
      const scopes = isGitBackupProvider(provider.id)
        ? []
        : selectedScopes(provider);
      if (scopes.length > 0)
        expect(run.action.scopes, provider.id).toBe(scopes.join(" "));
      covered.push(provider.id);
    }
    expect(covered).toEqual(listed.map((provider) => provider.id));
    expect(identitySeams.hostBase()).toBe("");
  });

  it("turns a section on and off in place and keeps its connectors listed", async () => {
    openConnectorPages();
    renderPanel();
    const ai = screen.getByRole("switch", { name: "AI" });
    expect(ai.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("capability-review")).toBeNull();
    expect(screen.getByRole("list", { name: "AI providers" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Anthropic/ })).toBeTruthy();
    fireEvent.click(ai);
    expect(screen.queryByTestId("capability-review")).toBeNull();
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).not.toContain(
      "agents.webmcp",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "AI" }).getAttribute("aria-checked"),
      ).toBe("false"),
    );
    fireEvent.click(screen.getByRole("switch", { name: "AI" }));
    expect(screen.queryByTestId("capability-review")).toBeNull();
    await waitFor(() => expect(double.commits).toHaveLength(2));
    expect(double.commits[1]?.draft.selectedOptional).toContain(
      "agents.webmcp",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "AI" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(screen.getByRole("list", { name: "AI providers" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Anthropic/ })).toBeTruthy();
    expect(screen.queryByTestId("capability-review")).toBeNull();
  });
});
