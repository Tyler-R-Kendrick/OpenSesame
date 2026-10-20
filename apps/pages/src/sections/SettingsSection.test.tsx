import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import type { JsonObject } from "@opensesame/os-domain";
import {
  type Folder,
  installItemType,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { VEHICLE_TYPE } from "./settings/vehicle-type.test-support.js";
import { PURGE_CONFIRM } from "./vault/vault-menu.js";

type TestItem = { id: string; name?: string; deletedAt?: string | null };
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
    emptyTrash: vi.fn(),
    restoreItem: vi.fn(),
    purgeItem: vi.fn(),
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
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));
const loadSettings = vi.hoisted(() => vi.fn());
const saveSettings = vi.hoisted(() => vi.fn());
import { settingsSeams } from "@opensesame/app-core/lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, { loadSettings, saveSettings });
afterAll(() => Object.assign(settingsSeams, originalSettingsSeams));
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
afterAll(() => Object.assign(passwordSeams, originalPasswordSeams));
import { registerOptionalTutorials } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import { type SettingsPanels, SettingsSection } from "./SettingsSection.js";
const stubPanels: SettingsPanels = {
  UnlockMethodsPanel: () => <div data-testid="unlock-methods-panel" />,
  InstallPanel: () => <div data-testid="install-panel" />,
  VaultsPanel: () => <div data-testid="vaults-panel" />,
};
const endpoints = {
  hostApi: "http://127.0.0.1:8787",
  identityApi: "http://127.0.0.1:8788",
  daemonApi: "http://127.0.0.1:18790",
  capabilityConnectors: { encryption: { providerId: "webcrypto" } },
};
let revokeTutorials: (() => void) | null = null;
beforeEach(() => {
  // The tutorial targets first: a category link binds its guide id, and the
  // registry refuses an id the live catalog does not declare.
  revokeTutorials = registerOptionalTutorials();
});
afterEach(() => {
  syncInstalledTypes({});
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
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Locking" })).toBeTruthy();
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

  it("splits Settings into Vault Settings and User Settings", async () => {
    renderSettings();
    expect(
      screen.getByRole("heading", { name: "Vault Settings" }),
    ).toBeTruthy();
    const areas = screen.getByRole("navigation", { name: "Settings area" });
    expect(
      within(areas)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Vault Settings", "User Settings"]);
    expect(
      within(areas)
        .getByRole("link", { name: "Vault Settings" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(screen.getByRole("navigation", { name: "Settings sections" }))
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["General", "Security", "Features", "Integrations", "Danger"]);

    await userEvent.click(
      within(areas).getByRole("link", { name: "User Settings" }),
    );
    expect(screen.getByRole("heading", { name: "User Settings" })).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Keybindings", "Vaults"]);
    expect(
      within(tabs)
        .getByRole("link", { name: "Keybindings" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("opens Vaults in User Settings, not in the vault's tabs", () => {
    renderSettings("/settings/vaults");
    expect(screen.getByRole("heading", { name: "User Settings" })).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Keybindings", "Vaults"]);
    expect(
      within(tabs)
        .getByRole("link", { name: "Vaults" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(screen.getByRole("navigation", { name: "Settings area" }))
        .getByRole("link", { name: "User Settings" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("activates categories from the hash and the nav", async () => {
    // `#taskbus` is a legacy Connections hash; Connections is Integrations now.
    renderSettings("#taskbus");
    expect(screen.getByTestId("integrations-panel")).toBeTruthy();
    const nav = screen.getByRole("navigation", {
      name: /Settings sections/i,
    });
    expect(
      nav.querySelector('[aria-current="page"]')?.textContent?.toLowerCase(),
    ).toBe("integrations");
    expect(within(nav).queryByRole("link", { name: "Connections" })).toBeNull();

    await userEvent.click(screen.getByRole("link", { name: /Danger/i }));
    expect(
      screen.getByRole("heading", { name: "Delete this vault" }),
    ).toBeTruthy();
  });

  // Settings is files. A row in the Form opens the file it is drawn from in
  // the source view, and the source view lists the category's files.
  it("opens an item type's file from its row in the file viewer", async () => {
    installItemType(VEHICLE_TYPE);
    renderSettings("/settings/vaults");
    await userEvent.click(
      screen.getByRole("button", { name: "Open vehicle.json" }),
    );
    // No representation switch: the file is addressed like a page.
    expect(screen.queryByRole("button", { name: "YAML" })).toBeNull();
    const files = screen.getByRole("navigation", { name: "Files" });
    // The directory's own document is the page, not a row in this list.
    expect(files.textContent).not.toContain("config.yaml");
    expect(files.textContent).toContain("marketplaces.json");
    expect(
      screen.getByRole("textbox", {
        name: "settings/item-types/installed/vehicle.json",
      }),
    ).toBeTruthy();
    // The directory's own tab is the road back to the form.
    await userEvent.click(
      within(
        screen.getByRole("navigation", { name: "Settings sections" }),
      ).getByRole("link", { name: "Vaults" }),
    );
    expect(screen.getByRole("heading", { name: "Item types" })).toBeTruthy();
  });

  // The nav declares a tab for each; each draws its own page (ADR 0189).
  it("draws the features panel and the integrations panel on their own categories", () => {
    renderSettings("#features");
    expect(screen.getByTestId("features-panel")).toBeTruthy();
    expect(screen.queryByTestId("integrations-panel")).toBeNull();
    cleanup();
    renderSettings("#integrations");
    expect(screen.getByTestId("integrations-panel")).toBeTruthy();
    expect(screen.queryByTestId("features-panel")).toBeNull();
  });

  it("shows the security category with one password form: the unlock methods", () => {
    renderSettings("#security");
    expect(screen.getByTestId("unlock-methods-panel")).toBeTruthy();
    // AGENTS.md: never a second PIN or password form.
    expect(
      screen.queryByRole("heading", { name: "Master password" }),
    ).toBeNull();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("opens Integrations from the old Connections and Backups paths", () => {
    for (const path of ["/settings/connections", "/settings/backups"]) {
      renderSettings(path);
      expect(screen.getByTestId("integrations-panel")).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: "Integrations" })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(screen.queryByText("Appearance")).toBeNull();
      cleanup();
    }
  });

  it("puts every provider on Integrations, with no Connections tab", () => {
    renderSettings("#connectivity");
    expect(screen.getByTestId("integrations-panel")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Core/ })).toBeNull();
    // No Endpoints panel — Host/Identity/daemon are not Pages backends.
    expect(screen.queryByRole("heading", { name: "Endpoints" })).toBeNull();
    expect(
      within(
        screen.getByRole("navigation", { name: "Settings sections" }),
      ).queryByRole("link", { name: "Endpoints" }),
    ).toBeNull();
    // Backups is a built-in function: its history roads act without a page.
    expect(screen.getByRole("region", { name: "Backups" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Backups" })).toBeTruthy();
    // The switches stay on Features.
    expect(screen.queryByRole("region", { name: "Identity" })).toBeNull();
  });

  it("lands a rail link on its panel on every tab, not only Security", () => {
    const scrollBy = vi.fn();
    vi.stubGlobal("scrollBy", scrollBy);
    renderSettings("/settings#settings-locking");
    expect(document.getElementById("settings-locking")).toBeTruthy();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    cleanup();
    renderSettings("/settings/danger#settings-delete-vault");
    expect(document.getElementById("settings-delete-vault")).toBeTruthy();
    expect(scrollBy).toHaveBeenCalledTimes(2);
    cleanup();
    renderSettings("/settings/danger#settings-trash");
    expect(document.getElementById("settings-trash")).toBeTruthy();
    expect(scrollBy).toHaveBeenCalledTimes(3);
  });

  it("destroys the vault only after confirmation", async () => {
    vault.current.items = [{ id: "itm_1" }, { id: "itm_2" }];
    renderSettings("#danger");
    await userEvent.click(
      screen.getByRole("button", { name: /Delete this vault/i }),
    );
    expect(
      screen.getByText(/2 items \(0 in trash\) will be unrecoverable/),
    ).toBeTruthy();
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

  it("lists the trash and empties it only after arming", async () => {
    vault.current.items = [
      { id: "itm_1", name: "Alpha", deletedAt: "2026-09-01" },
      { id: "itm_2", name: "Beta", deletedAt: "2026-09-02" },
    ];
    renderSettings("#danger");
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText(/2 items in the trash/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Empty the trash/i }),
    );
    expect(screen.getByText(/emptying is unrecoverable/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(store.emptyTrash).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /Empty the trash/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Empty the trash/i }),
    );
    expect(store.emptyTrash).toHaveBeenCalledTimes(1);
  });

  it("restores a single trashed item", async () => {
    vault.current.items = [
      { id: "itm_1", name: "Alpha", deletedAt: "2026-09-01" },
    ];
    renderSettings("#danger");
    await userEvent.click(
      screen.getByRole("button", { name: "Restore Alpha" }),
    );
    expect(store.restoreItem).toHaveBeenCalledWith("itm_1");
  });

  it("purges a single trashed item only after arming", async () => {
    vault.current.items = [
      { id: "itm_1", name: "Alpha", deletedAt: "2026-09-01" },
    ];
    renderSettings("#danger");
    await userEvent.click(
      screen.getByRole("button", { name: "Delete Alpha permanently" }),
    );
    expect(store.purgeItem).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: PURGE_CONFIRM }));
    expect(store.purgeItem).toHaveBeenCalledWith("itm_1");
  });

  it("draws no trash keys when the trash is empty", () => {
    vault.current.items = [{ id: "itm_1", name: "Alpha" }];
    renderSettings("#danger");
    expect(screen.getByText("Trash is empty.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Empty the trash/i }),
    ).toBeNull();
  });
});
