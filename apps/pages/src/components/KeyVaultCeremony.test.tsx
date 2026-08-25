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
// SAFETY: checked against the code under test — the popup handle is only compared to null, no Window member is dereferenced.
const openConsentPopup = vi.fn(() => ({}) as Window);

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
  it("states the real crypto the built-in vault uses", () => {
    render(<KeyVaultCeremony onClose={() => {}} />);
    expect(screen.getByText("WebCrypto (this device)")).toBeTruthy();
    expect(screen.getByText("AES-GCM 256")).toBeTruthy();
    // The iteration count is read from the constant the vault actually uses,
    // not typed into the copy, so it cannot drift away from the code.
    expect(screen.getByText(/PBKDF2-SHA256 · 600,000 iterations/)).toBeTruthy();
  });

  it("closes on the keep-it action, because nothing needs doing", () => {
    const onClose = vi.fn();
    render(<KeyVaultCeremony onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Keep the built-in vault" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("binds a hardware key from inside the sheet", () => {
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Bind a YubiKey or FIDO2 key/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "YubiKey" }));
    expect(bindCapabilityConnector).toHaveBeenCalledWith(
      "encryption",
      "yubikey",
    );
  });

  it("asks for authorization once a bound connector needs it", () => {
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Bind a YubiKey or FIDO2 key/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "YubiKey" }));
    // The card has to change with the news: bound-but-unauthorized is not
    // "Active", and the action that clears it is the one now on offer.
    expect(screen.getByText("Bound, not yet authorized")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Authorize on Host" }),
    ).toBeTruthy();
  });

  it("opens the consent popup on the click itself", async () => {
    authorizeCapabilityConnector.mockResolvedValue({
      tone: "ok",
      text: "YubiKey authorized.",
    });
    binding = { providerId: "yubikey" };
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Authorize on Host" }));
    // Browsers only allow window.open synchronously from a gesture; opening it
    // after the awaited Host session would be blocked as a pop-up.
    expect(openConsentPopup).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByText("YubiKey authorized.")).toBeTruthy(),
    );
  });

  it("reports a refusal rather than pretending it bound", async () => {
    authorizeCapabilityConnector.mockResolvedValue({
      tone: "err",
      text: "denied",
    });
    binding = { providerId: "aws-kms" };
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Authorize on Host" }));
    await waitFor(() => expect(screen.getByText("denied")).toBeTruthy());
  });

  it("offers the cloud connectors the catalog actually allows", () => {
    render(<KeyVaultCeremony onClose={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Bind a cloud KMS connector/ }),
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
      screen.getByRole("button", { name: /Bind a cloud KMS connector/ }),
    );
    expect(container.querySelector("a")).toBeNull();
  });
});
