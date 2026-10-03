import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import { settingsFields } from "@opensesame/app-core/sections/settings/settings-files.js";
/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { GeneralPrefsPanel } from "./GeneralPrefsPanel.js";

const setPrefs = vi.fn();
const commitPrefs = vi.fn(async (next: VaultPrefs) => {
  setPrefs(next);
});
const writePrefsSource = vi.fn(async () => undefined);
const readPrefsSource = vi.fn(async () => null);

const originalVaultHooksSeams = { ...vaultHooksSeams };

function installVaultSeams(): void {
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => ({
      setPrefs,
      commitPrefs,
      writePrefsSource,
      readPrefsSource,
      activeTomb: () => "personal",
    }),
    useVault: () => ({
      prefs: {
        theme: "system",
        autoLockMinutes: 0,
        lockOnHide: false,
        signOutOnLock: false,
        clipboardClearSeconds: 30,
        prefsRevision: 2,
      },
    }),
  });
}

describe("GeneralPrefsPanel", () => {
  beforeEach(() => {
    installVaultSeams();
  });

  afterEach(() => {
    cleanup();
    setPrefs.mockClear();
    commitPrefs.mockClear();
    Object.assign(vaultHooksSeams, originalVaultHooksSeams);
  });

  it("commits appearance and locking as they change", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GeneralPrefsPanel />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "Night" }));
    expect(commitPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
    await user.selectOptions(
      screen.getByLabelText(/Lock after inactivity/i),
      "60",
    );
    expect(commitPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ autoLockMinutes: 60 }),
    );
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Visual" })).toBeNull();
  });

  it("draws no sign-out-of-Identity switch while there is no Identity to sign out of", () => {
    render(
      <MemoryRouter>
        <GeneralPrefsPanel />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("switch", {
        name: "Also sign out of Identity when the vault locks",
      }),
    ).toBeNull();
    // Locking's other switch is the vault's own and always acts.
    expect(
      screen.getByRole("switch", {
        name: "Lock when this tab goes to the background",
      }),
    ).toBeTruthy();
  });

  it("keeps a stored sign-out-on-lock where it can be seen again: absent with no Identity, on when Identity returns, and always in the General settings file", () => {
    Object.assign(vaultHooksSeams, {
      useVault: () => ({
        prefs: {
          theme: "system",
          autoLockMinutes: 0,
          lockOnHide: false,
          signOutOnLock: true,
          clipboardClearSeconds: 30,
          prefsRevision: 2,
        },
      }),
    });
    const name = "Also sign out of Identity when the vault locks";
    const bare = render(
      <MemoryRouter>
        <GeneralPrefsPanel />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("switch", { name })).toBeNull();
    bare.unmount();

    const original = identityHookSeams.useIdentitySession;
    identityHookSeams.useIdentitySession = () =>
      overlapCast({ accessToken: "t", issuerOrigin: "x" });
    try {
      render(
        <MemoryRouter>
          <GeneralPrefsPanel />
        </MemoryRouter>,
      );
      expect(
        screen.getByRole("switch", { name }).getAttribute("aria-checked"),
      ).toBe("true");
    } finally {
      identityHookSeams.useIdentitySession = original;
    }
    // The value is the vault's own preference, readable and writable as the
    // prefs file whatever Identity is: nothing about it is lost by the row.
    expect(settingsFields("general").map((field) => field.key)).toContain(
      "signOutOnLock",
    );
  });

  it("draws it, with no caption, once an Identity session is held", async () => {
    const original = identityHookSeams.useIdentitySession;
    identityHookSeams.useIdentitySession = () =>
      overlapCast({ accessToken: "t", issuerOrigin: "x" });
    try {
      const user = userEvent.setup();
      const { container } = render(
        <MemoryRouter>
          <GeneralPrefsPanel />
        </MemoryRouter>,
      );
      await user.click(
        screen.getByRole("switch", {
          name: "Also sign out of Identity when the vault locks",
        }),
      );
      expect(commitPrefs).toHaveBeenCalledWith(
        expect.objectContaining({ signOutOnLock: true }),
      );
      expect(container.textContent).not.toMatch(/otherwise auto-lock/);
    } finally {
      identityHookSeams.useIdentitySession = original;
    }
  });
});
