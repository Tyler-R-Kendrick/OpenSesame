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
  GcpKmsConnectPanel,
  gcpKmsConnectDependencies,
} from "./GcpKmsConnectPanel.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

afterEach(() => {
  cleanup();
});

// The connector settings page mounts guide targets `connectors.external`
// contributes; these cases describe a deployment that approved it.
declareConnectionsTutorial();

const originalVault = vaultHooksSeams.useVault;
const originalDeps = { ...gcpKmsConnectDependencies };

const KEY_NAME =
  "projects/demo-project/locations/us-central1/keyRings/ring/cryptoKeys/vault-root";
const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  client_email: "wrap@demo-project.iam.gserviceaccount.com",
});

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

function gcpProvider(): Provider {
  const bundled = getBundledProviders().find((row) => row.id === "gcp-kms");
  if (!bundled) throw new Error("gcp-kms missing from catalog");
  return bundled;
}

describe("Google Cloud KMS connector", () => {
  beforeEach(() => {
    Object.assign(gcpKmsConnectDependencies, originalDeps);
    vaultHooksSeams.useVault = () =>
      vaultState({ status: "unlocked", guest: false, tomb: "personal" });
    gcpKmsConnectDependencies.loadSettings = () => ({
      capabilityConnectors: { encryption: { providerId: "webcrypto" } },
    });
    gcpKmsConnectDependencies.readGcpKmsConfig = async () => ({
      keyName: "",
      projectId: "",
      serviceAccountJson: "",
      label: null,
      configVersion: "0",
    });
    gcpKmsConnectDependencies.writeGcpKmsConfig = async (_tomb, input) => ({
      keyName: input.keyName.trim(),
      projectId: input.projectId?.trim() || "demo-project",
      serviceAccountJson: input.serviceAccountJson || "kept-secret",
      label: input.label?.trim() || null,
      configVersion: "1",
    });
    gcpKmsConnectDependencies.clearGcpKmsConfig = async () => undefined;
    gcpKmsConnectDependencies.bindCapabilityConnector = (_cap, providerId) => ({
      providerId,
    });
  });

  afterEach(() => {
    vaultHooksSeams.useVault = originalVault;
    Object.assign(gcpKmsConnectDependencies, originalDeps);
  });

  it("ships configuration fields on the bundled GCP KMS provider", () => {
    const provider = gcpProvider();
    expect(provider.displayName).toBe("Google Cloud KMS");
    expect(provider.configured).toBe(true);
    expect(provider.configurationFields?.map((field) => field.name)).toEqual([
      "crypto_key_name",
      "project_id",
      "service_account_json",
    ]);
  });

  it("renders the GCP KMS panel on the connector settings page", () => {
    render(
      <MemoryRouter initialEntries={["/settings/connections/gcp-kms"]}>
        <ConnectorSettingsPage
          provider={gcpProvider()}
          providerId="gcp-kms"
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
    expect(screen.getByLabelText(/Crypto key/)).toBeTruthy();
    expect(screen.queryByText(/connects over OAuth/i)).toBeNull();
  });

  it("seals credentials from the panel", async () => {
    const user = userEvent.setup();
    const onFlash = vi.fn();
    const write = vi.fn(gcpKmsConnectDependencies.writeGcpKmsConfig);
    gcpKmsConnectDependencies.writeGcpKmsConfig = write;
    render(<GcpKmsConnectPanel onFlash={onFlash} />);
    await user.type(screen.getByLabelText(/Crypto key/), KEY_NAME);
    await user.type(screen.getByLabelText(/Project ID/), "demo-project");
    const secret = screen.getByLabelText(/Service account JSON/);
    await user.click(secret);
    await user.paste(SERVICE_ACCOUNT);
    await user.click(
      screen.getByRole("button", { name: "Save Google Cloud KMS" }),
    );
    expect(write).toHaveBeenCalled();
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    );
  });
});
