import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import type { JsonObject } from "@opensesame/os-domain";
import { type Folder, syncInstalledTypes } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(store.destroy).toHaveBeenCalledTimes(1);
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
