import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { defaultPrefs } from "@opensesame/app-core/lib/vault/prefs.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import {
  AzureKeyVaultKeysConnectPanel,
  azureKeyVaultKeysConnectDependencies,
} from "./AzureKeyVaultKeysConnectPanel.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

afterEach(() => {
  cleanup();
});

// The connector settings page mounts guide targets `connectors.external`
// contributes; these cases describe a deployment that approved it.
declareConnectionsTutorial();

const originalVault = vaultHooksSeams.useVault;
const originalDeps = { ...azureKeyVaultKeysConnectDependencies };

const VERSIONED_KEY =
  "https://contoso.vault.azure.net/keys/vault-root/0123456789abcdef0123456789abcdef";
const TENANT = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";

function vaultState(
  partial: Pick<VaultState, "status" | "guest" | "tomb">,
): VaultState {
  return {
    status: partial.status,
    tomb: partial.tomb,
    guest: partial.guest,
    header: null,
    items: [],
    folders: [],
    prefs: defaultPrefs,
    lockedOutUntil: null,
    failedAttempts: 0,
    awaitingSecondStep: false,
    durable: true,
  };
}

function azureProvider(): Provider {
  const bundled = getBundledProviders().find(
    (row) => row.id === "azure-key-vault-keys",
  );
  if (!bundled) throw new Error("azure-key-vault-keys missing from catalog");
  return bundled;
}

describe("Azure Key Vault Keys connector", () => {
  beforeEach(() => {
    Object.assign(azureKeyVaultKeysConnectDependencies, originalDeps);
    vaultHooksSeams.useVault = () =>
      vaultState({ status: "unlocked", guest: false, tomb: "personal" });
    azureKeyVaultKeysConnectDependencies.loadSettings = () => ({
      capabilityConnectors: { encryption: { providerId: "webcrypto" } },
    });
    azureKeyVaultKeysConnectDependencies.readAzureKeyVaultKeysConfig =
      async () => ({
        versionedKeyId: "",
        tenantId: "",
        clientId: "",
        clientSecret: "",
        label: null,
        configVersion: "0",
      });
    azureKeyVaultKeysConnectDependencies.writeAzureKeyVaultKeysConfig = async (
      _tomb,
      input,
    ) => ({
      versionedKeyId: input.versionedKeyId.trim(),
      tenantId: input.tenantId.trim(),
      clientId: input.clientId.trim(),
      clientSecret: input.clientSecret || "kept-secret",
      label: input.label?.trim() || null,
      configVersion: "1",
    });
    azureKeyVaultKeysConnectDependencies.clearAzureKeyVaultKeysConfig =
      async () => undefined;
    azureKeyVaultKeysConnectDependencies.bindCapabilityConnector = (
      _cap,
      providerId,
    ) => ({ providerId });
  });

  afterEach(() => {
    vaultHooksSeams.useVault = originalVault;
    Object.assign(azureKeyVaultKeysConnectDependencies, originalDeps);
  });

  it("ships configuration fields on the bundled Azure Key Vault Keys provider", () => {
    const provider = azureProvider();
    expect(provider.displayName).toBe("Azure Key Vault Keys");
    expect(provider.configured).toBe(true);
    expect(provider.configurationFields?.map((field) => field.name)).toEqual([
      "versioned_key_id",
      "tenant_id",
      "client_id",
      "client_secret",
    ]);
  });

  it("renders the Azure panel on the connector settings page", () => {
    render(
      <MemoryRouter
        initialEntries={["/settings/connections/azure-key-vault-keys"]}
      >
        <ConnectorSettingsPage
          provider={azureProvider()}
          providerId="azure-key-vault-keys"
          connection={null}
          connections={[]}
          loading={false}
          online
          canConfigure
          configureHint=""
          flash={null}
          rememberOffer={null}
          onFlash={vi.fn()}
          onRememberOffer={vi.fn()}
          onChanged={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Connect" })).toBeTruthy();
    expect(screen.getByLabelText(/Versioned key ID/)).toBeTruthy();
    expect(screen.queryByText(/connects over OAuth/i)).toBeNull();
  });

  it("seals credentials from the panel", async () => {
    const user = userEvent.setup();
    const onFlash = vi.fn();
    const write = vi.fn(
      azureKeyVaultKeysConnectDependencies.writeAzureKeyVaultKeysConfig,
    );
    azureKeyVaultKeysConnectDependencies.writeAzureKeyVaultKeysConfig = write;
    render(<AzureKeyVaultKeysConnectPanel onFlash={onFlash} />);
    await user.type(screen.getByLabelText(/Versioned key ID/), VERSIONED_KEY);
    await user.type(screen.getByLabelText(/Tenant ID/), TENANT);
    await user.type(screen.getByLabelText(/Client ID/), CLIENT);
    await user.type(screen.getByLabelText(/Client secret/), "super-secret");
    await user.click(
      screen.getByRole("button", { name: "Save Azure Key Vault Keys" }),
    );
    expect(write).toHaveBeenCalled();
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    );
  });
});
