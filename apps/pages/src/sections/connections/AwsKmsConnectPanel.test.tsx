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
import {
  AwsKmsConnectPanel,
  awsKmsConnectDependencies,
} from "./AwsKmsConnectPanel.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

afterEach(() => {
  cleanup();
});

// The connector settings page mounts guide targets `connectors.external`
// contributes; these cases describe a deployment that approved it.
declareConnectionsTutorial();

const originalVault = vaultHooksSeams.useVault;
const originalDeps = { ...awsKmsConnectDependencies };

const KEY_ARN =
  "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";

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

function awsKmsProvider(): Provider {
  const bundled = getBundledProviders().find((row) => row.id === "aws-kms");
  if (!bundled) throw new Error("aws-kms missing from catalog");
  return bundled;
}

describe("AWS KMS connector", () => {
  beforeEach(() => {
    Object.assign(awsKmsConnectDependencies, originalDeps);
    vaultHooksSeams.useVault = () =>
      vaultState({ status: "unlocked", guest: false, tomb: "personal" });
    awsKmsConnectDependencies.loadSettings = () => ({
      capabilityConnectors: { encryption: { providerId: "webcrypto" } },
    });
    awsKmsConnectDependencies.readAwsKmsConfig = async () => ({
      keyArn: "",
      region: "",
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: null,
      label: null,
      configVersion: "0",
    });
    awsKmsConnectDependencies.writeAwsKmsConfig = async (_tomb, input) => ({
      keyArn: input.keyArn.trim(),
      region: input.region?.trim() || "us-east-1",
      accessKeyId: input.accessKeyId.trim(),
      secretAccessKey: input.secretAccessKey || "kept-secret",
      sessionToken: input.sessionToken?.trim() || null,
      label: input.label?.trim() || null,
      configVersion: "1",
    });
    awsKmsConnectDependencies.clearAwsKmsConfig = async () => undefined;
    awsKmsConnectDependencies.bindCapabilityConnector = (_cap, providerId) => ({
      providerId,
    });
  });

  afterEach(() => {
    vaultHooksSeams.useVault = originalVault;
    Object.assign(awsKmsConnectDependencies, originalDeps);
  });

  it("ships configuration fields on the bundled AWS KMS provider", () => {
    const provider = awsKmsProvider();
    expect(provider.displayName).toBe("AWS KMS");
    expect(provider.configured).toBe(true);
    expect(provider.configurationFields?.map((field) => field.name)).toEqual([
      "key_arn",
      "region",
      "access_key_id",
      "secret_access_key",
      "session_token",
    ]);
  });

  it("renders the AWS KMS panel on the connector settings page", () => {
    render(
      <MemoryRouter initialEntries={["/settings/connections/aws-kms"]}>
        <ConnectorSettingsPage
          provider={awsKmsProvider()}
          providerId="aws-kms"
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
    expect(screen.getByLabelText(/Key ARN/)).toBeTruthy();
    expect(screen.queryByText(/connects over OAuth/i)).toBeNull();
  });

  it("seals credentials from the panel", async () => {
    const user = userEvent.setup();
    const onFlash = vi.fn();
    const write = vi.fn(awsKmsConnectDependencies.writeAwsKmsConfig);
    awsKmsConnectDependencies.writeAwsKmsConfig = write;
    render(<AwsKmsConnectPanel onFlash={onFlash} />);
    await user.type(screen.getByLabelText(/Key ARN/), KEY_ARN);
    await user.type(screen.getByLabelText(/^Region/), "us-east-1");
    await user.type(
      screen.getByLabelText(/Access key ID/),
      "AKIATESTACCESSKEY1",
    );
    await user.type(
      screen.getByLabelText(/Secret access key/),
      "super-secret-value",
    );
    await user.click(screen.getByRole("button", { name: "Save AWS KMS" }));
    expect(write).toHaveBeenCalled();
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    );
  });
});
