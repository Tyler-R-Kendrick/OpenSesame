/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import type { VaultPrefs } from "../../lib/vault/store.js";
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
});
