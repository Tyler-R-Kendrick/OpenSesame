import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import type { JsonObject } from "@opensesame/os-domain";
import type { Folder } from "@opensesame/vault-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { settingsSeams } from "@opensesame/app-core/lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, { loadSettings, saveSettings });
import { passwordSeams } from "@opensesame/app-core/lib/vault/password.js";
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
import { registerOptionalTutorials } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
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
let revokeTutorials: (() => void) | null = null;
beforeEach(() => {
  // The tutorial targets first: a category link binds its guide id, and the
  // registry refuses an id the live catalog does not declare.
  revokeTutorials = registerOptionalTutorials();
});
afterEach(() => {
  revokeTutorials?.();
  revokeTutorials = null;
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
    // `#taskbus` is a legacy Connections hash; Connections is Capabilities now.
    renderSettings("#taskbus");
    expect(screen.getByTestId("capabilities-panel")).toBeTruthy();
    const nav = screen.getByRole("navigation", {
      name: /Settings sections/i,
    });
    expect(
      nav.querySelector('[aria-current="page"]')?.textContent?.toLowerCase(),
    ).toBe("capabilities");
    expect(screen.queryByRole("link", { name: "Connections" })).toBeNull();

    await userEvent.click(screen.getByRole("link", { name: /Danger/i }));
    expect(
      screen.getByRole("heading", { name: "Delete this vault" }),
    ).toBeTruthy();
  });

  // Settings is files. A row in the Form opens the file it is drawn from in
  // the source view, and the source view lists the category's files.
  it("opens an item type's file from its row in the file viewer", async () => {
    renderSettings("/settings/vaults");
    await userEvent.click(
      screen.getByRole("button", { name: "Open wifi.json" }),
    );
    expect(
      screen.getByRole("button", { name: "YAML" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const files = screen.getByRole("navigation", { name: "Files" });
    expect(files.textContent).toContain("vaults.yaml");
    expect(files.textContent).toContain("marketplaces.json");
    expect(
      screen.getByRole("textbox", {
        name: "settings/item-types/builtin/wifi.json",
      }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Form" }));
    expect(screen.getByRole("heading", { name: "Item types" })).toBeTruthy();
  });

  // The nav has declared a Capabilities tab since the composition work
  // landed, but the section drew nothing for it, so the tab opened empty.
  it("draws the capabilities panel on its own category", () => {
    renderSettings("#capabilities");
    expect(screen.getByTestId("capabilities-panel")).toBeTruthy();
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

  it("opens Capabilities from the old Connections and Backups paths", () => {
    for (const path of ["/settings/connections", "/settings/backups"]) {
      renderSettings(path);
      expect(screen.getByTestId("capabilities-panel")).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: "Capabilities" })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(screen.queryByText("Appearance")).toBeNull();
      cleanup();
    }
  });

  it("puts every provider on Capabilities, with no Connections tab", () => {
    renderSettings("#connectivity");
    expect(screen.queryByRole("heading", { name: /^Core/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Endpoints" })).toBeNull();
    expect(screen.getByRole("region", { name: "Providers" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Identity providers" }),
    ).toBeTruthy();
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
