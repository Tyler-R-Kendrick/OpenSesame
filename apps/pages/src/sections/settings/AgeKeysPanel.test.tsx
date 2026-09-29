/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { AgeKeysPanel, ageKeysPanelDependencies } from "./AgeKeysPanel.js";

const original = { ...vaultHooksSeams };
const originalDependencies = { ...ageKeysPanelDependencies };

beforeEach(() => {
  ageKeysPanelDependencies.readAgeKeyConfig = vi.fn(async () => ({
    recipients: [],
    identity: null,
    identities: [],
  }));
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ tomb: null, header: null, guest: true }),
  });
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
  Object.assign(ageKeysPanelDependencies, originalDependencies);
});

describe("AgeKeysPanel", () => {
  it("is absent when there is no vault to seal into — no row of disabled keys", () => {
    const { container } = render(<AgeKeysPanel />);
    expect(container.querySelector("#age-keys")).toBeNull();
    expect(container.querySelector("button, textarea, input")).toBeNull();
    expect(screen.queryByText(/Unlock a vault/)).toBeNull();
  });

  it("is drawn, every control usable, once a vault can hold the keys", () => {
    Object.assign(vaultHooksSeams, {
      useVault: () => ({ tomb: "personal", header: null, guest: false }),
    });
    const { container } = render(<AgeKeysPanel />);
    expect(container.querySelector("#age-keys")).toBeTruthy();
    expect(screen.getByLabelText("Recipients").hasAttribute("disabled")).toBe(
      false,
    );
    expect(
      screen
        .getByRole("button", { name: "Generate identity" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("draws no encryption preference, and Prove is not held by one", () => {
    Object.assign(vaultHooksSeams, {
      useVault: () => ({ tomb: "personal", header: null, guest: false }),
    });
    render(<AgeKeysPanel />);
    expect(screen.queryByText(/Use age on this device/)).toBeNull();
    expect(screen.queryByText(/Encryption/)).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Prove round-trip" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
