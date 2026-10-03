/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { VaultKeyProtectionPanel } from "./VaultKeyProtectionPanel.js";
import {
  type VaultViewState,
  agePasskey,
  ageRecipient,
  awsKms,
  azure,
  deviceLocal,
  gcpKms,
  headerWithRecords,
  passkeyWrap,
  passwordHeader,
  pin,
  recoveryKey,
  yubikey,
} from "./vault-protection-fixtures.test-support.js";

const originalVaultHooksSeams = { ...vaultHooksSeams };
const ensureProtectionProjected = vi.fn(async () => undefined);

function useVaultState(state: VaultViewState) {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      header: passwordHeader(),
      tomb: "personal",
      ...state,
    }),
  });
}

function showRecords(records: Parameters<typeof headerWithRecords>[0]) {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      header: headerWithRecords(records),
      guest: false,
      status: "unlocked",
      tomb: "personal",
    }),
  });
  render(<VaultKeyProtectionPanel />);
}

beforeEach(() => {
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => ({
      protection: {
        ensureProtectionProjected,
        enrollCandidate: vi.fn(),
        commitEnrollment: vi.fn(),
        testProtector: vi.fn(),
        setPreferred: vi.fn(),
        removeProtector: vi.fn(),
        rotateCompromisedRoot: vi.fn(),
        listProtectors: vi.fn(() => []),
      },
      getSnapshot: () => ({ header: passwordHeader() }),
    }),
  });
  useVaultState({ guest: false, status: "unlocked" });
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});

describe("VaultKeyProtectionPanel", () => {
  it("lists enrolled Password from the header wrap, never WebCrypto", () => {
    render(<VaultKeyProtectionPanel />);
    expect(
      screen.getByRole("heading", { name: "Vault key protection" }),
    ).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByLabelText("Verified")).toBeTruthy();
    expect(screen.queryByText(/WebCrypto/i)).toBeNull();
  });

  it("draws no static policy prose and no row without an action", () => {
    const { container } = render(<VaultKeyProtectionPanel />);
    expect(
      screen.queryByRole("list", { name: "Protection policy" }),
    ).toBeNull();
    expect(screen.queryByText(/No enrolled method/)).toBeNull();
    expect(screen.queryByTestId("setup-intent")).toBeNull();
    // Every row carries at least one key — none is a bare status.
    for (const row of container.querySelectorAll("[data-protector-id]")) {
      expect(row.querySelectorAll("button").length).toBeGreaterThan(0);
    }
  });

  it("offers Test only where the service can prove it — not for Password, PIN or passkey", () => {
    render(<VaultKeyProtectionPanel />);
    expect(screen.queryByRole("button", { name: /^Test Password/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Preferred unlock Password/ }),
    ).toBeTruthy();
    // Its wrap is removed under Unlock methods, so no Remove is drawn here.
    expect(
      screen.queryByRole("button", { name: /^Remove Password/ }),
    ).toBeNull();
  });

  it("marks the preferred unlock and draws no key on it: pressing it again would do nothing", () => {
    const base = headerWithRecords([recoveryKey, pin]);
    Object.assign(vaultHooksSeams, {
      useVault: () => ({
        header: base.protection
          ? {
              ...base,
              protection: {
                ...base.protection,
                preferredProtectorId: recoveryKey.protectorId,
              },
            }
          : base,
        guest: false,
        status: "unlocked",
        tomb: "personal",
      }),
    });
    render(<VaultKeyProtectionPanel />);
    expect(screen.getByRole("img", { name: "Preferred unlock" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Preferred unlock Recovery key" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Preferred unlock PIN" }),
    ).toBeTruthy();
  });

  it("offers Test on a recovery key, which the service proves from its secret", () => {
    showRecords([recoveryKey]);
    expect(
      screen.getByRole("button", { name: /^Test Recovery key/ }),
    ).toBeTruthy();
  });

  it("offers Test on every kind the browser can open, and on none it cannot", () => {
    showRecords([
      ageRecipient,
      agePasskey,
      awsKms,
      gcpKms,
      yubikey,
      azure,
      deviceLocal,
    ]);
    for (const label of [
      "age recipient",
      "age passkey",
      "AWS KMS",
      "Google Cloud KMS",
    ]) {
      expect(
        screen.getByRole("button", { name: `Test ${label}` }),
      ).toBeTruthy();
    }
    for (const label of [
      "YubiKey PIV through age",
      "Azure Key Vault Keys",
      "Device-local key",
    ]) {
      expect(
        screen.queryByRole("button", { name: `Test ${label}` }),
      ).toBeNull();
      // Remove acts on the manifest for a protector that opens nothing at the
      // unlock screen; Preferred is a choice among the wraps that do.
      expect(
        screen.queryByRole("button", { name: `Preferred unlock ${label}` }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: `Remove ${label}` }),
      ).toBeTruthy();
    }
  });

  it("draws Preferred for everything that opens the vault, Remove for everything but its own wraps", () => {
    showRecords([pin, passkeyWrap, recoveryKey]);
    for (const label of ["PIN", "Passkey / security key"]) {
      expect(
        screen.getByRole("button", { name: `Preferred unlock ${label}` }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: `Remove ${label}` }),
      ).toBeNull();
    }
    // A verified recovery key opens the vault at the unlock screen (ADR 0152):
    // it can be preferred, and it is removed here.
    expect(
      screen.getByRole("button", { name: "Preferred unlock Recovery key" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove Recovery key" }),
    ).toBeTruthy();
  });

  it("draws no Preferred for a protector the unlock screen cannot use", () => {
    // Untested: never opened with its identity. Cloud: its credential is
    // sealed in the vault it protects. Neither is drawn at unlock.
    showRecords([ageRecipient, awsKms, gcpKms, agePasskey]);
    for (const label of ["age recipient", "AWS KMS", "Google Cloud KMS"]) {
      expect(
        screen.queryByRole("button", { name: `Preferred unlock ${label}` }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: `Remove ${label}` }),
      ).toBeTruthy();
    }
    expect(
      screen.getByRole("button", { name: "Preferred unlock age passkey" }),
    ).toBeTruthy();
  });

  it("marks a verified cloud key whose credential this vault seals as not a way back in", () => {
    showRecords([recoveryKey, awsKms]);
    const row = (id: string) =>
      document.querySelector(`[data-protector-id="${id}"]`);
    const note = "Its credential is sealed in this vault";
    expect(row("aws_1")?.querySelector(`[aria-label^="${note}"]`)).toBeTruthy();
    expect(row("aws_1")?.querySelector('[aria-label="Verified"]')).toBeTruthy();
    expect(
      row("recovery-key_a")?.querySelector(`[aria-label^="${note}"]`),
    ).toBeNull();
  });

  it("marks a verified cloud key whose credential this vault seals as not a way back in", () => {
    showRecords([recoveryKey, awsKms]);
    const row = (id: string) =>
      document.querySelector(`[data-protector-id="${id}"]`);
    const note = "Its credential is sealed in this vault";
    expect(row("aws_1")?.querySelector(`[aria-label^="${note}"]`)).toBeTruthy();
    expect(row("aws_1")?.querySelector('[aria-label="Verified"]')).toBeTruthy();
    expect(
      row("recovery-key_a")?.querySelector(`[aria-label^="${note}"]`),
    ).toBeNull();
  });

  it("every key on the panel is enabled when it is drawn", () => {
    const { container } = render(<VaultKeyProtectionPanel />);
    const keys = container.querySelectorAll("button");
    // Add, Rotate, and the password row's Preferred.
    expect(keys.length).toBe(3);
    for (const key of keys) {
      expect(key.hasAttribute("disabled")).toBe(false);
    }
  });

  it("writes the manifest once it can act, so a row's id is one the service holds", () => {
    ensureProtectionProjected.mockClear();
    render(<VaultKeyProtectionPanel />);
    expect(ensureProtectionProjected).toHaveBeenCalledTimes(1);
  });

  it("does not project for a guest, whose protectors are not changed here", () => {
    ensureProtectionProjected.mockClear();
    useVaultState({ guest: true, status: "unlocked" });
    render(<VaultKeyProtectionPanel />);
    expect(ensureProtectionProjected).not.toHaveBeenCalled();
  });

  it("is absent for a guest — there is no key to act on", () => {
    useVaultState({ guest: true, status: "unlocked" });
    const { container } = render(<VaultKeyProtectionPanel />);
    expect(container.querySelector("#vault-key-protection")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("is absent in the guest's own tomb even once a key is enrolled in it", () => {
    // `guest` (ephemeral) goes false when a key is enrolled; the tomb stays the
    // guest's, and the service refuses protector changes there.
    useVaultState({ guest: false, status: "unlocked", tomb: "guest" });
    const { container } = render(<VaultKeyProtectionPanel />);
    expect(container.querySelector("#vault-key-protection")).toBeNull();
  });

  it("is absent while the vault is locked", () => {
    useVaultState({ guest: false, status: "locked" });
    const { container } = render(<VaultKeyProtectionPanel />);
    expect(container.querySelector("#vault-key-protection")).toBeNull();
  });

  it("opens the add sheet from the add key", () => {
    render(<VaultKeyProtectionPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add key protection method" }),
    );
    expect(screen.getByRole("dialog", { name: "Add" })).toBeTruthy();
  });

  it("opens the rotate sheet from the rotate key", () => {
    render(<VaultKeyProtectionPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Rotate compromised vault key" }),
    );
    expect(screen.getByRole("dialog", { name: "Rotate" })).toBeTruthy();
  });

  it("calls supplied action props", () => {
    const onAdd = vi.fn();
    const onPreferred = vi.fn();
    render(
      <VaultKeyProtectionPanel
        actions={{
          onAdd,
          onTest: vi.fn(),
          onPreferred,
          onRemove: vi.fn(),
          onRotateCompromised: vi.fn(),
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add key protection method" }),
    );
    expect(onAdd).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: /Preferred unlock Password/i }),
    );
    expect(onPreferred).toHaveBeenCalled();
  });

  it("uses icon-btn actions only — no word-verb button faces", () => {
    const { container } = render(<VaultKeyProtectionPanel />);
    for (const button of container.querySelectorAll("button")) {
      expect(button.className).toMatch(/icon-btn/);
      expect(button.textContent?.trim()).toBe("");
    }
  });
});
