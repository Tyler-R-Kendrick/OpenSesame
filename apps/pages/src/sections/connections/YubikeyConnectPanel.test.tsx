/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../lib/connections.js";
import { getBundledProviders } from "../../lib/embedded-catalog.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { defaultPrefs } from "../../lib/vault/prefs.js";
import type { VaultState } from "../../lib/vault/store.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import {
  YubikeyConnectPanel,
  yubikeyConnectDependencies,
} from "./YubikeyConnectPanel.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

afterEach(() => {
  cleanup();
});

// The connector settings page mounts guide targets `connectors.external`
// contributes; these cases describe a deployment that approved it.
declareConnectionsTutorial();

const originalVault = vaultHooksSeams.useVault;
const originalDeps = { ...yubikeyConnectDependencies };

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

function yubikeyProvider(): Provider {
  const bundled = getBundledProviders().find((row) => row.id === "yubikey");
  if (!bundled) throw new Error("yubikey missing from catalog");
  return bundled;
}

describe("YubiKey connector", () => {
  beforeEach(() => {
    Object.assign(yubikeyConnectDependencies, originalDeps);
    vaultHooksSeams.useVault = () =>
      vaultState({ status: "unlocked", guest: false, tomb: "personal" });
    yubikeyConnectDependencies.loadSettings = () => ({
      capabilityConnectors: { encryption: { providerId: "webcrypto" } },
    });
    yubikeyConnectDependencies.readYubikeyConfig = async () => ({
      recipient: "",
      slot: null,
      serialHint: null,
      label: null,
    });
    yubikeyConnectDependencies.writeYubikeyConfig = async (_tomb, input) => ({
      recipient: input.recipient.trim(),
      slot: input.slot?.trim() || null,
      serialHint: input.serialHint?.trim() || null,
      label: input.label?.trim() || null,
    });
    yubikeyConnectDependencies.clearYubikeyConfig = async () => undefined;
    yubikeyConnectDependencies.bindCapabilityConnector = (
      _cap,
      providerId,
    ) => ({
      providerId,
    });
  });

  afterEach(() => {
    vaultHooksSeams.useVault = originalVault;
    Object.assign(yubikeyConnectDependencies, originalDeps);
  });

  it("ships configuration fields on the bundled YubiKey provider", () => {
    const provider = yubikeyProvider();
    expect(provider.displayName).toBe("YubiKey");
    expect(provider.configured).toBe(true);
    expect(provider.configurationFields?.map((field) => field.name)).toEqual([
      "recipient",
      "slot",
      "serial",
    ]);
  });

  it("renders the YubiKey panel on the connector settings page", () => {
    render(
      <MemoryRouter initialEntries={["/settings/connections/yubikey"]}>
        <ConnectorSettingsPage
          provider={yubikeyProvider()}
          providerId="yubikey"
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
    expect(screen.getByLabelText(/Recipient/)).toBeTruthy();
    expect(screen.queryByText(/connects over OAuth/i)).toBeNull();
  });

  it("seals a recipient from the panel", async () => {
    const user = userEvent.setup();
    const onFlash = vi.fn();
    const write = vi.fn(yubikeyConnectDependencies.writeYubikeyConfig);
    yubikeyConnectDependencies.writeYubikeyConfig = write;
    render(<YubikeyConnectPanel onFlash={onFlash} />);
    await user.type(
      screen.getByLabelText(/Recipient/),
      "age1yubikey1q2w3e4r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0z1x2c3v4b5n6m7",
    );
    await user.click(screen.getByRole("button", { name: "Save YubiKey" }));
    expect(write).toHaveBeenCalled();
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    );
  });
});
