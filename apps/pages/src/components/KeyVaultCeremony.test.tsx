/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { KeyVaultCeremony } from "./KeyVaultCeremony.js";

const original = { ...vaultHooksSeams };

type ViewState = { status: string; guest: boolean; tomb?: string };

function vault(state: ViewState) {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ tomb: "personal", ...state }),
    useVaultStore: () => ({ protection: {} }),
  });
}

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
});

describe("KeyVaultCeremony", () => {
  it("adds a key that protects the vault — the same choices Security enrolls", () => {
    vault({ status: "unlocked", guest: false });
    render(<KeyVaultCeremony onClose={() => {}} />);
    for (const name of [
      "Recovery key",
      "Passkey / security key",
      "age recipient",
      "AWS KMS",
      "Google Cloud KMS",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("offers no setup preference and no connection to authorize", () => {
    vault({ status: "unlocked", guest: false });
    render(<KeyVaultCeremony onClose={() => {}} />);
    expect(screen.queryByText(/setup preference/i)).toBeNull();
    expect(screen.queryByText(/Authorize connection/i)).toBeNull();
    expect(screen.queryByText(/YubiKey/i)).toBeNull();
    expect(screen.queryByText(/Azure/i)).toBeNull();
  });

  it("draws nothing for a guest, a guest's tomb or a locked vault", () => {
    for (const state of [
      { status: "unlocked", guest: true },
      { status: "unlocked", guest: false, tomb: "guest" },
      { status: "locked", guest: false },
    ]) {
      vault(state);
      const { container, unmount } = render(
        <KeyVaultCeremony onClose={() => {}} />,
      );
      expect(container.textContent).toBe("");
      unmount();
    }
  });
});
