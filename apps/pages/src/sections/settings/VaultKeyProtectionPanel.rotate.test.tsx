/** @vitest-environment jsdom */
import { webauthnHostSeams } from "@opensesame/app-core/lib/vault/webauthn-host.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { VaultKeyProtectionPanel } from "./VaultKeyProtectionPanel.js";
import {
  headerWithRecords,
  passwordHeader,
} from "./vault-protection-fixtures.test-support.js";

const original = { ...vaultHooksSeams };
const originalHost = { ...webauthnHostSeams };

function passkeysWork(ok: boolean) {
  Object.assign(webauthnHostSeams, {
    checkWebauthnHost: () => ({
      ok,
      hostname: "localhost",
      reason: "",
      fixUrl: null,
    }),
  });
}

function openRotate(header: ReturnType<typeof passwordHeader>) {
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => ({
      protection: {
        ensureProtectionProjected: vi.fn(async () => undefined),
        listProtectors: vi.fn(() => []),
        rotateCompromisedRoot: vi.fn(),
      },
      getSnapshot: () => ({ header }),
    }),
    useVault: () => ({
      header,
      guest: false,
      status: "unlocked",
      tomb: "personal",
    }),
  });
  render(<VaultKeyProtectionPanel />);
  fireEvent.click(
    screen.getByRole("button", { name: "Rotate compromised vault key" }),
  );
  return screen.getByRole("dialog", { name: "Rotate" });
}

beforeEach(() => Object.assign(vaultHooksSeams, original));
afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
  Object.assign(webauthnHostSeams, originalHost);
});

describe("the rotate sheet's password", () => {
  it("asks for the current master password, because the store proves it before rotating", () => {
    const sheet = openRotate(headerWithRecords([]));
    expect(sheet.textContent).toContain(
      "A new vault key; the master password is wrapped anew",
    );
    const field = screen.getByLabelText("Master password");
    expect(field.getAttribute("autocomplete")).toBe("current-password");
  });

  it("never gives a vault without a password one: it is re-keyed under a new passkey, with nothing typed", () => {
    passkeysWork(true);
    const { wrap: _wrap, kdf: _kdf, ...bare } = passwordHeader();
    const sheet = openRotate({ ...bare, protection: undefined });
    expect(sheet.textContent).toContain("a new passkey opens it");
    expect(sheet.textContent).not.toContain("becomes the master password");
    expect(screen.queryByLabelText("Master password")).toBeNull();
    expect(screen.queryByLabelText("New master password")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Rotate" })
        .disabled,
    ).toBe(false);
  });

  it("asks for a new PIN instead where the browser cannot make a passkey", () => {
    passkeysWork(false);
    const { wrap: _wrap, kdf: _kdf, ...bare } = passwordHeader();
    const sheet = openRotate({ ...bare, protection: undefined });
    expect(sheet.textContent).toContain("the new PIN opens it");
    const field = screen.getByLabelText("New PIN");
    expect(field.getAttribute("autocomplete")).toBe("new-password");
    expect(screen.queryByLabelText("Master password")).toBeNull();
  });
});
