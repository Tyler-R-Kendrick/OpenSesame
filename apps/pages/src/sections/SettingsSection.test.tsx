import type { JsonObject } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "../lib/vault/model.js";
import type { VaultPrefs } from "../lib/vault/store.js";
type TestItem = { id: string; deletedAt?: string | null; sample?: boolean };
const vault: {
  current: {
    prefs: VaultPrefs;
    items: TestItem[];
    folders: Folder[];
    header: JsonObject | null;
  };
} = vi.hoisted(() => ({
  current: {
    prefs: {
      theme: "system",
      autoLockMinutes: 0,
      clipboardClearSeconds: 30,
      lockOnHide: false,
      signOutOnLock: false,
    },
    items: [],
    folders: [],
    header: null,
  },
}));
const store = vi.hoisted(() => {
  const api = {
    setPrefs: vi.fn(),
    commitPrefs: vi.fn(),
    writePrefsSource: vi.fn(async () => undefined),
    readPrefsSource: vi.fn(async () => null),
    activeTomb: () => "personal",
    changeMasterPassword: vi.fn(),
    addFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    addItems: vi.fn(),
    replaceAll: vi.fn(),
    exportSealed: vi.fn(),
    importSealed: vi.fn(),
    applyManifestMerge: vi.fn(),
    destroy: vi.fn(),
  };
  api.commitPrefs.mockImplementation(async (next) => api.setPrefs(next));
  return api;
});
import { vaultHooksSeams } from "../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
});
const loadSettings = vi.hoisted(() => vi.fn());
const saveSettings = vi.hoisted(() => vi.fn());
import { settingsSeams } from "../lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, { loadSettings, saveSettings });
import { passwordSeams } from "../lib/vault/password.js";
const originalPasswordSeams = { ...passwordSeams };
Object.assign(passwordSeams, {
  estimateStrength: (password: string) => ({
    score: password.length >= 12 ? 3 : 1,
    label: password.length >= 12 ? "Strong" : "Weak",
    bits: password.length * 4,
  }),
  defaultPassphraseOptions: { mode: "passphrase", words: 4, separator: "-" },
  generate: () => "harbor-cinder-lattice-quarry",
});
import { registerLegacySettingsCategories } from "../lib/contributions.test-support.js";
import { registerOptionalTutorials } from "../tutorial/registry/optional-tutorials.test-support.js";
import { type SettingsPanels, SettingsSection } from "./SettingsSection.js";
const stubPanels: SettingsPanels = {
  UnlockMethodsPanel: () => <div data-testid="unlock-methods-panel" />,
  InstallPanel: () => <div data-testid="install-panel" />,
  VaultsPanel: () => <div data-testid="vaults-panel" />,
  ModelProviderPanel: () => <div data-testid="model-provider-panel" />,
};
const endpoints = {
  hostApi: "http://127.0.0.1:8787",
  identityApi: "http://127.0.0.1:8788",
  daemonApi: "http://127.0.0.1:18790",
  mfaAppUrl: "",
  capabilityConnectors: { encryption: { providerId: "webcrypto" } },
};
/**
 * Connections is not a core Settings category: the connectors capability
 * contributes it, with the panel it draws. These tests are about the shell —
 * that the hash alias, the rest path and the nav all reach the contributed
 * category and mount its panel — so the panel here is a stand-in, and what
 * the real one renders is `modules/connectors.external`'s own test.
 */
function ConnectionsCategoryStub() {
  return (
    <>
      <h2>Connections</h2>
      <stubPanels.ModelProviderPanel />
    </>
  );
}

let revokeConnections: readonly (() => void)[] = [];
beforeEach(() => {
  revokeConnections = [
    // The tutorial targets first: a category link binds `settings.connections`,
    // and the registry refuses an id the live catalog does not declare.
    registerOptionalTutorials(),
    registerLegacySettingsCategories(ConnectionsCategoryStub),
  ];
});
afterEach(() => {
  for (const revoke of revokeConnections) revoke();
});

function renderSettings(entry = "") {
  const path = entry.startsWith("/") ? entry : `/settings${entry}`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSection panels={stubPanels} />
    </MemoryRouter>,
  );
}

describe("SettingsSection", () => {
  beforeEach(() => {
    vault.current = {
      prefs: {
        theme: "system",
        autoLockMinutes: 0,
        clipboardClearSeconds: 30,
        lockOnHide: false,
        signOutOnLock: false,
      },
      items: [],
      folders: [],
      header: { wrap: {}, kdf: { iterations: 600_000 } },
    };
    loadSettings.mockReturnValue({ ...endpoints });
    store.exportSealed.mockReturnValue('{"sealed":true}');
    store.importSealed.mockResolvedValue(2);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:mock"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens on General with appearance and locking controls", () => {
    renderSettings();
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Locking")).toBeTruthy();
    // Child panels from other categories stay unmounted.
    expect(screen.queryByTestId("unlock-methods-panel")).toBeNull();
    expect(screen.queryByTestId("taskbus-panel")).toBeNull();
  });

  it("switches theme and locking preferences", async () => {
    renderSettings();
    await userEvent.click(screen.getByRole("button", { name: /Night/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await userEvent.selectOptions(
      screen.getByLabelText(/Lock after inactivity/i),
      "60",
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/Clear copied secrets after/i),
      "0",
    );
    await userEvent.click(
      screen.getByLabelText(/Lock when this tab goes to the background/i),
    );
    await userEvent.click(
      screen.getByLabelText(/Also sign out of Identity when the vault locks/i),
    );
    expect(store.commitPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
    expect(store.commitPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ autoLockMinutes: 60 }),
    );
    expect(store.commitPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ clipboardClearSeconds: 0 }),
    );
    expect(store.commitPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ lockOnHide: true }),
    );
    expect(store.commitPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ signOutOnLock: true }),
    );
  });

  it("activates categories from the hash and the nav", async () => {
    renderSettings("#taskbus");
    expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
    const nav = screen.getByRole("navigation", {
      name: /Settings sections/i,
    });
    expect(
      nav.querySelector('[aria-current="page"]')?.textContent?.toLowerCase(),
    ).toBe("connections");

    await userEvent.click(screen.getByRole("link", { name: /Danger/i }));
    expect(
      screen.getByRole("heading", { name: "Delete this vault" }),
    ).toBeTruthy();
  });

  it("shows the security category with unlock methods and master password", async () => {
    renderSettings("#security");
    expect(screen.getByTestId("unlock-methods-panel")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Master password" }),
    ).toBeTruthy();
  });

  it("changes the master password and clears the form", async () => {
    renderSettings("#security");
    await userEvent.type(screen.getByLabelText("Current"), "old-password-1");
    await userEvent.type(
      screen.getByLabelText("New password"),
      "new-password-12",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Change master password/i }),
    );
    expect(store.changeMasterPassword).toHaveBeenCalledWith(
      "old-password-1",
      "new-password-12",
    );
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Master password changed/,
    );
  });

  it("surfaces master password change failures", async () => {
    store.changeMasterPassword.mockRejectedValue(new Error("wrong current"));
    renderSettings("#security");
    await userEvent.type(screen.getByLabelText("Current"), "old-password-1");
    await userEvent.type(
      screen.getByLabelText("New password"),
      "new-password-12",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Change master password/i }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /wrong current/,
    );
  });

  it("disables re-key when there is no password wrap or it is too weak", async () => {
    vault.current.header = null;
    renderSettings("#security");
    expect(screen.getByText(/no master-password unlock/)).toBeTruthy();
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: /Change master password/i,
    });
    expect(button.disabled).toBe(true);
  });

  it("shows the live strength read-out for the new password", async () => {
    renderSettings("#security");
    await userEvent.type(
      screen.getByLabelText("New password"),
      "new-password-12",
    );
    expect(screen.getByText("Strong")).toBeTruthy();
    expect(screen.getByText("60 bits")).toBeTruthy();
  });

  it("suggests a password, revealing it rather than asking for a confirm", async () => {
    renderSettings("#security");
    const field = screen.getByLabelText<HTMLInputElement>("New password");
    expect(field.type).toBe("password");
    await userEvent.click(
      screen.getByRole("button", { name: /Suggest a strong password/i }),
    );
    const revealed = screen.getByLabelText<HTMLInputElement>("New password");
    expect(revealed.type).toBe("text");
    expect(revealed.value.length).toBeGreaterThan(11);
    expect(screen.queryByLabelText("Confirm")).toBeNull();
  });

  it("opens a category from a rest path", () => {
    renderSettings("/settings/connections");
    expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Connections" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByText("Appearance")).toBeNull();
  });

  it("renders the connectivity child panels", () => {
    renderSettings("#connectivity");
    expect(screen.queryByRole("heading", { name: /^Core/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Project" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Endpoints" })).toBeNull();
    expect(screen.queryByTestId("active-project-panel")).toBeNull();
    expect(screen.getByTestId("model-provider-panel")).toBeTruthy();
  });

  it("destroys the vault only after confirmation", async () => {
    vault.current.items = [{ id: "itm_1" }, { id: "itm_2" }];
    renderSettings("#danger");
    await userEvent.click(
      screen.getByRole("button", { name: /Delete this vault/i }),
    );
    expect(screen.getByText(/2 items will be unrecoverable/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(store.destroy).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /Delete this vault/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Delete permanently/i }),
    );
    expect(store.destroy).toHaveBeenCalled();
  });
});
