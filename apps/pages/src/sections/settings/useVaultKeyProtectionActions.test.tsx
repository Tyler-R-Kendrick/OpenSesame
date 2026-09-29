/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { VaultKeyProtectionPanel } from "./VaultKeyProtectionPanel.js";
import { vaultKeyProtectionActionDependencies } from "./useVaultKeyProtectionActions.js";
import {
  agePasskey,
  ageRecipient,
  awsKms,
  gcpKms,
  headerWithRecords,
} from "./vault-protection-fixtures.test-support.js";

const original = { ...vaultHooksSeams };
const originalDependencies = { ...vaultKeyProtectionActionDependencies };
const testCloudFlow = vi.fn(async () => undefined);
const protection = {
  ensureProtectionProjected: vi.fn(async () => undefined),
  testProtector: vi.fn(async () => undefined),
};

function mount(records: Parameters<typeof headerWithRecords>[0]) {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      header: headerWithRecords(records),
      tomb: "personal",
      status: "unlocked",
      guest: false,
    }),
    useVaultStore: () => ({ protection }),
  });
  render(<VaultKeyProtectionPanel />);
}

beforeEach(() => {
  testCloudFlow.mockClear();
  protection.testProtector.mockClear();
  Object.assign(vaultKeyProtectionActionDependencies, { testCloudFlow });
});
afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
  Object.assign(vaultKeyProtectionActionDependencies, originalDependencies);
});

describe("Test, by kind", () => {
  it("proves a cloud key with the connection saved on this device", async () => {
    mount([awsKms, gcpKms]);
    fireEvent.click(screen.getByRole("button", { name: "Test AWS KMS" }));
    await waitFor(() =>
      expect(testCloudFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          protectorId: awsKms.protectorId,
          kind: "aws-kms",
          tomb: "personal",
        }),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Test Google Cloud KMS" }),
    );
    await waitFor(() =>
      expect(testCloudFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          protectorId: gcpKms.protectorId,
          kind: "gcp-kms",
        }),
      ),
    );
    expect(protection.testProtector).not.toHaveBeenCalled();
  });

  it("opens a sheet for an age recipient, which needs an identity typed", () => {
    mount([ageRecipient]);
    fireEvent.click(screen.getByRole("button", { name: "Test age recipient" }));
    expect(screen.getByRole("dialog", { name: "Test" })).toBeTruthy();
    expect(testCloudFlow).not.toHaveBeenCalled();
  });

  it("leaves the age passkey to its own ceremony through the service", async () => {
    mount([agePasskey]);
    fireEvent.click(screen.getByRole("button", { name: "Test age passkey" }));
    await waitFor(() =>
      expect(protection.testProtector).toHaveBeenCalledWith(
        agePasskey.protectorId,
      ),
    );
  });
});
