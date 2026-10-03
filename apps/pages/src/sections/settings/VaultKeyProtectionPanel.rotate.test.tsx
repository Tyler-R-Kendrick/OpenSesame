/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { VaultKeyProtectionPanel } from "./VaultKeyProtectionPanel.js";
import {
  headerWithRecords,
  passwordHeader,
} from "./vault-protection-fixtures.test-support.js";

const original = { ...vaultHooksSeams };

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

  it("says the password entered becomes the master password when none is enrolled, and asks for a new one", () => {
    const { wrap: _wrap, kdf: _kdf, ...bare } = passwordHeader();
    const sheet = openRotate({ ...bare, protection: undefined });
    expect(sheet.textContent).toContain(
      "the password entered becomes the master password",
    );
    const field = screen.getByLabelText("New master password");
    expect(field.getAttribute("autocomplete")).toBe("new-password");
  });
});
