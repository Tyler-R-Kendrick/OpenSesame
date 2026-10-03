import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { defaultPrefs } from "@opensesame/app-core/lib/vault/prefs.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import {
  awsKms,
  headerWithRecords,
} from "../settings/vault-protection-fixtures.test-support.js";
import {
  AwsKmsConnectPanel,
  awsKmsConnectDependencies,
} from "./AwsKmsConnectPanel.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";
import { useAwsKmsConnect } from "./useAwsKmsConnect.js";

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

  describe("with a saved configuration", () => {
    const OTHER_ARN =
      "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-1234-1234-1234-123456789012";
    const REMOVE = "Remove AWS KMS configuration";
    const saved = {
      keyArn: KEY_ARN,
      region: "us-east-1",
      accessKeyId: "AKIATESTACCESSKEY1",
      secretAccessKey: "sealed-secret",
      sessionToken: null,
      label: null,
      configVersion: "1",
    };

    function useSaved(enrolled: boolean) {
      awsKmsConnectDependencies.readAwsKmsConfig = async () => saved;
      const header = enrolled
        ? headerWithRecords([{ ...awsKms, keyArn: KEY_ARN }])
        : null;
      vaultHooksSeams.useVault = () => ({
        ...vaultState({ status: "unlocked", guest: false, tomb: "personal" }),
        header,
      });
    }

    it("draws no Remove key before anything is configured", async () => {
      render(<AwsKmsConnectPanel onFlash={vi.fn()} />);
      await screen.findByRole("button", { name: "Save AWS KMS" });
      expect(screen.queryByRole("button", { name: REMOVE })).toBeNull();
    });

    it("draws an enabled Remove key once configured and unenrolled", async () => {
      useSaved(false);
      render(<AwsKmsConnectPanel onFlash={vi.fn()} />);
      const remove = await screen.findByRole("button", { name: REMOVE });
      expect(remove.hasAttribute("disabled")).toBe(false);
    });

    it("draws no Remove key while a protector on the key is enrolled", async () => {
      useSaved(true);
      render(<AwsKmsConnectPanel onFlash={vi.fn()} />);
      await screen.findByLabelText("Protects this vault's key");
      expect(screen.queryByRole("button", { name: REMOVE })).toBeNull();
    });

    it("draws the key identity read-only while a protector is enrolled", async () => {
      useSaved(true);
      render(<AwsKmsConnectPanel onFlash={vi.fn()} />);
      await screen.findByLabelText("Protects this vault's key");
      expect(screen.getByLabelText(/Key ARN/).hasAttribute("readonly")).toBe(
        true,
      );
      expect(screen.getByLabelText(/^Region/).hasAttribute("readonly")).toBe(
        true,
      );
    });

    it("leaves the key editable when no protector depends on it", async () => {
      useSaved(false);
      render(<AwsKmsConnectPanel onFlash={vi.fn()} />);
      await screen.findByRole("button", { name: REMOVE });
      expect(screen.getByLabelText(/Key ARN/).hasAttribute("readonly")).toBe(
        false,
      );
    });

    it("refuses a save that would replace an enrolled key", async () => {
      useSaved(true);
      const onFlash = vi.fn();
      const write = vi.fn(awsKmsConnectDependencies.writeAwsKmsConfig);
      awsKmsConnectDependencies.writeAwsKmsConfig = write;
      const { result } = renderHook(() => useAwsKmsConnect(onFlash));
      await waitFor(() => expect(result.current.configured).toBe(true));
      expect(result.current.enrolled).toBe(true);
      act(() => result.current.setField("keyArn", OTHER_ARN));
      await act(async () => {
        await result.current.save({ preventDefault: vi.fn() } as never);
      });
      expect(write).not.toHaveBeenCalled();
      expect(onFlash).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "err" }),
      );
    });

    it("still rotates credentials for the same enrolled key", async () => {
      useSaved(true);
      const user = userEvent.setup();
      const onFlash = vi.fn();
      const write = vi.fn(awsKmsConnectDependencies.writeAwsKmsConfig);
      awsKmsConnectDependencies.writeAwsKmsConfig = write;
      render(<AwsKmsConnectPanel onFlash={onFlash} />);
      await screen.findByLabelText("Protects this vault's key");
      await user.type(
        screen.getByLabelText(/^Secret access key \(/),
        "rotated-secret",
      );
      await user.click(screen.getByRole("button", { name: "Save AWS KMS" }));
      expect(write).toHaveBeenCalledWith(
        "personal",
        expect.objectContaining({
          keyArn: KEY_ARN,
          secretAccessKey: "rotated-secret",
        }),
      );
      expect(onFlash).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "ok" }),
      );
    });
  });
});
