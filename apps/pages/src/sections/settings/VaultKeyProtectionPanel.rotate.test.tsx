/** @vitest-environment jsdom */
import type { RotationKey } from "@opensesame/app-core/lib/vault/protection/browser-lifecycle-ops.js";
import { webauthnHostSeams } from "@opensesame/app-core/lib/vault/webauthn-host.js";
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

const rotateCompromisedRoot = vi.fn(async (_input: RotationKey) => undefined);

function openRotate(header: ReturnType<typeof passwordHeader>) {
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => ({
      protection: {
        ensureProtectionProjected: vi.fn(async () => undefined),
        listProtectors: vi.fn(() => []),
        rotateCompromisedRoot,
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

beforeEach(() => {
  Object.assign(vaultHooksSeams, original);
  rotateCompromisedRoot.mockClear();
});
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

  it("rotates a vault with no password under a new passkey, typing nothing", async () => {
    passkeysWork(true);
    const { wrap: _wrap, kdf: _kdf, ...bare } = passwordHeader();
    openRotate({ ...bare, protection: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() =>
      expect(rotateCompromisedRoot).toHaveBeenCalledWith({ passkey: true }),
    );
    expect(rotateCompromisedRoot).toHaveBeenCalledTimes(1);
  });

  it("rotates under the typed PIN where the browser cannot make a passkey, and not before one is typed", async () => {
    passkeysWork(false);
    const { wrap: _wrap, kdf: _kdf, ...bare } = passwordHeader();
    openRotate({ ...bare, protection: undefined });
    const rotate = screen.getByRole<HTMLButtonElement>("button", {
      name: "Rotate",
    });
    expect(rotate.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New PIN"), {
      target: { value: "73920146" },
    });
    expect(rotate.disabled).toBe(false);
    fireEvent.click(rotate);
    await waitFor(() =>
      expect(rotateCompromisedRoot).toHaveBeenCalledWith({ pin: "73920146" }),
    );
  });

  it("proves the master password a vault holds, and only then rotates", async () => {
    passkeysWork(true);
    openRotate(headerWithRecords([]));
    const rotate = screen.getByRole<HTMLButtonElement>("button", {
      name: "Rotate",
    });
    expect(rotate.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Master password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(rotate);
    await waitFor(() =>
      expect(rotateCompromisedRoot).toHaveBeenCalledWith({
        password: "correct horse battery staple",
      }),
    );
  });

  it("does not name the key it keeps among the methods it removes", () => {
    passkeysWork(true);
    const withPasskey = {
      ...passwordHeader(),
      wrap: undefined,
      kdf: undefined,
      protection: undefined,
      unlocks: {
        passkey: {
          credentialIdB64: "Y3JlZA==",
          userIdB64: "dXNlcg==",
          prfSaltB64: "c2FsdA==",
          wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
        },
      },
    };
    const sheet = openRotate(withPasskey);
    expect(sheet.textContent).toContain("nothing else");
  });
});
