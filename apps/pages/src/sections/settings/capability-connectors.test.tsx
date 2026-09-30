/** @vitest-environment jsdom */
import { FEATURES } from "@opensesame/app-core/lib/capabilities/features.js";
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { double } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { connectorActs } from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  createConnection,
  getConnection,
  listConnections,
  setConnectionConfiguration,
  setConnectionCredential,
} from "@opensesame/app-core/lib/connections.js";
import { configurationPayload } from "@opensesame/app-core/lib/connector-guidance.js";
import {
  forgetDeviceConnectors,
  renderedConnectorRecord,
  saveForgeConnector,
} from "@opensesame/app-core/lib/device-connectors.js";
import type { GitRemoteConfiguration } from "@opensesame/app-core/lib/git-auth-modes.js";
import { isGitBackupProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import { forgetAllLocalGitRemotes } from "@opensesame/app-core/lib/git-remote-local.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapabilityFeature } from "../../lib/capability-feature-operation.js";
import {
  installPanelFixture,
  renderPanel,
} from "./capabilities-panel.test-support.js";
import { providerTileItems } from "./provider-tile-items.js";

installDoublePorts();
installPanelFixture();

const originalIdentity = { ...identitySeams };

function listedProviders(): Provider[] {
  const acts = (provider: Provider) => connectorActs(provider, false);
  const seen = new Set<string>();
  const providers: Provider[] = [];
  for (const feature of FEATURES) {
    for (const category of feature.providerCategories) {
      for (const item of providerTileItems(category, acts)) {
        if (seen.has(item.provider.id)) continue;
        seen.add(item.provider.id);
        providers.push(item.provider);
      }
    }
  }
  return providers;
}

function displayName(provider: Provider): string {
  return `pub-${provider.id}-name`;
}

function fieldValue(provider: Provider, name: string, secret: boolean): string {
  if (name === "remote_url")
    return `https://git.example/${provider.id}/repo.git`;
  if (name === "auth_mode") return "https_token";
  if (name === "domain") return `${provider.id}.example`;
  return `${secret ? "sek" : "pub"}-${provider.id}-${name}`;
}

const GIT_SECRET_KEYS = new Set([
  "token",
  "password",
  "ssh_private_key",
  "ssh_passphrase",
]);

function catalogValues(provider: Provider): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of provider.configurationFields ?? []) {
    values[field.name] = fieldValue(provider, field.name, field.secret);
  }
  if (isGitBackupProvider(provider.id)) {
    values.remote_url ??= `https://git.example/${provider.id}/repo.git`;
    values.auth_mode ??= "https_token";
    values.token ??= `sek-${provider.id}-token`;
  }
  return values;
}

function secretNames(provider: Provider): Set<string> {
  const names = new Set(
    (provider.configurationFields ?? [])
      .filter((field) => field.secret)
      .map((field) => field.name),
  );
  if (isGitBackupProvider(provider.id)) {
    for (const key of GIT_SECRET_KEYS) names.add(key);
  }
  return names;
}

function publicFrom(
  provider: Provider,
  values: Record<string, string>,
): Record<string, string> {
  const hidden = secretNames(provider);
  return Object.fromEntries(
    Object.entries(values).filter(
      ([name, value]) => !hidden.has(name) && value.trim() !== "",
    ),
  );
}

function selectedScopes(provider: Provider): string[] {
  if (provider.authKind === "oauth2_authorization_code") {
    return provider.scopes.map((scope) => scope.name);
  }
  return provider.scopes
    .filter((scope) => scope.default)
    .map((scope) => scope.name);
}

function gitConfiguration(
  values: Record<string, string>,
): GitRemoteConfiguration {
  const configuration: GitRemoteConfiguration & Record<string, string> = {
    remote_url: values.remote_url ?? "https://git.example/repo.git",
    auth_mode: "https_token",
  };
  for (const [name, value] of Object.entries(values))
    configuration[name] = value;
  configuration.auth_mode = "https_token";
  return configuration;
}

function expectedSecrets(provider: Provider): Record<string, string> {
  const values = catalogValues(provider);
  if (isGitBackupProvider(provider.id))
    return publicSplit(provider, values).secrets;
  const secrets: Record<string, string> = {};
  if (provider.authKind === "api_key")
    secrets.credential = `sek-${provider.id}-credential`;
  const payload = configurationPayload(
    provider,
    withoutApiKeyField(provider, values),
  );
  for (const [name, value] of Object.entries(payload)) {
    if (typeof value === "string" && secretNames(provider).has(name)) {
      secrets[name] = value;
    }
  }
  return secrets;
}

function withoutApiKeyField(
  provider: Provider,
  values: Record<string, string>,
): Record<string, string> {
  if (provider.authKind !== "api_key") return values;
  return Object.fromEntries(
    Object.entries(values).filter(([name]) => name !== "api_key"),
  );
}

function publicSplit(
  provider: Provider,
  values: Record<string, string>,
): { fields: Record<string, string>; secrets: Record<string, string> } {
  const fields: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value.trim() === "") continue;
    if (secretNames(provider).has(name)) secrets[name] = value;
    else fields[name] = value;
  }
  return { fields, secrets };
}

function expectedPublic(provider: Provider): Record<string, string> {
  const values = catalogValues(provider);
  if (isGitBackupProvider(provider.id))
    return publicSplit(provider, values).fields;
  const payload = configurationPayload(
    provider,
    withoutApiKeyField(provider, values),
  );
  return publicFrom(provider, payload);
}

async function saveListed(provider: Provider) {
  const name = displayName(provider);
  if (isGitBackupProvider(provider.id)) {
    return saveForgeConnector(provider, {
      displayName: name,
      configuration: gitConfiguration(catalogValues(provider)),
    });
  }
  const scopes = selectedScopes(provider);
  const connection = await createConnection({
    providerId: provider.id,
    displayName: name,
    scopes: scopes.length > 0 ? scopes : undefined,
  });
  if (provider.authKind === "api_key") {
    await setConnectionCredential(
      connection.connectionId,
      `sek-${provider.id}-credential`,
    );
  }
  const payload = configurationPayload(
    provider,
    withoutApiKeyField(provider, catalogValues(provider)),
  );
  if (
    provider.authKind === "configuration" ||
    Object.keys(payload).length > 0
  ) {
    await setConnectionConfiguration(connection.connectionId, payload);
  }
  return connection;
}

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
