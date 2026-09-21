/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilityConnectorBinding } from "../lib/capabilities.js";
import {
  KeyVaultCeremony,
  keyVaultCeremonyDependencies,
} from "./KeyVaultCeremony.js";

const original = { ...keyVaultCeremonyDependencies };

let binding: CapabilityConnectorBinding;
const bindCapabilityConnector = vi.fn(
  (_id: string, providerId: string): CapabilityConnectorBinding => {
    binding = { providerId };
    return binding;
  },
);
const authorizeCapabilityConnector = vi.fn();
const openConsentPopup = vi.fn(() => window);

beforeEach(() => {
  binding = { providerId: "webcrypto" };
  bindCapabilityConnector.mockClear();
  authorizeCapabilityConnector.mockReset();
  openConsentPopup.mockClear();
  Object.assign(keyVaultCeremonyDependencies, {
    ...original,
    loadSettings: () => ({
      capabilityConnectors: { encryption: binding, history: {} },
    }),
    bindCapabilityConnector,
    authorizeCapabilityConnector,
    openConsentPopup,
  });
});

afterEach(() => {
  cleanup();
  Object.assign(keyVaultCeremonyDependencies, original);
});

describe("KeyVaultCeremony", () => {
  it("labels the local preference as Password, never WebCrypto", () => {
    render(<KeyVaultCeremony onClose={() => {}} />);
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.queryByText(/WebCrypto/i)).toBeNull();
    expect(screen.getByText("AES-GCM 256")).toBeTruthy();
    expect(screen.getByText(/PBKDF2-SHA256 · 600,000 iterations/)).toBeTruthy();
    expect(screen.getByText("Setup preference")).toBeTruthy();
  });

  it("closes on keep-preference, because enrollment is elsewhere", () => {
    const onClose = vi.fn();
    render(<KeyVaultCeremony onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Keep this preference" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("binds age as a local preference from inside the sheet", () => {
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /age recipient \(recovery\)/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "age recipient" }));
    expect(bindCapabilityConnector).toHaveBeenCalledWith("encryption", "age");
  });

  it("binds a hardware key from inside the sheet", () => {
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: /YubiKey PIV \(advanced\)/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "YubiKey PIV through age" }),
    );
    expect(bindCapabilityConnector).toHaveBeenCalledWith(
      "encryption",
      "yubikey",
    );
  });

  it("asks for authorization once a bound connector needs it", () => {
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: /YubiKey PIV \(advanced\)/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "YubiKey PIV through age" }),
    );
    expect(screen.getByText("Bound, not yet authorized")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Authorize connection" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Host/i)).toBeNull();
  });

  it("opens the consent popup on the click itself", async () => {
    authorizeCapabilityConnector.mockResolvedValue({
      tone: "ok",
      text: "YubiKey authorized.",
    });
    binding = { providerId: "yubikey" };
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Authorize connection" }),
    );
    expect(openConsentPopup).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByText(/authorized for vault key protection/i),
      ).toBeTruthy(),
    );
  });

  it("reports a refusal rather than pretending it bound", async () => {
    authorizeCapabilityConnector.mockResolvedValue({
      tone: "err",
      text: "denied",
    });
    binding = { providerId: "aws-kms" };
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Authorize connection" }),
    );
    await waitFor(() => expect(screen.getByText("denied")).toBeTruthy());
  });

  it("offers cloud connectors as vault-key protection connections", () => {
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Cloud KMS/,
      }),
    );
    expect(screen.getByRole("button", { name: /AWS KMS/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Azure Key Vault/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Google Cloud KMS/ }),
    ).toBeTruthy();
  });

  it("never renders a link out of the sheet", () => {
    const { container } = render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Cloud KMS/,
      }),
    );
    expect(container.querySelector("a")).toBeNull();
  });
});
