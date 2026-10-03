import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
/** @vitest-environment jsdom */
import { MemoryRouter, useLocation } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const prefs: VaultPrefs = {
  theme: "system",
  autoLockMinutes: 0,
  clipboardClearSeconds: 30,
  lockOnHide: false,
  signOutOnLock: false,
};
const vault = {
  prefs,
  items: [],
  folders: [],
  header: { wrap: {}, kdf: { iterations: 600_000 } },
};
const store = vi.hoisted(() => ({
  setPrefs: vi.fn(),
  commitPrefs: vi.fn(),
  writePrefsSource: vi.fn(async () => undefined),
  readPrefsSource: vi.fn(async () => null),
  activeTomb: () => "personal",
}));
import { vaultHooksSeams } from "../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault,
  useVaultStore: () => store,
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));
import { settingsSeams } from "@opensesame/app-core/lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, {
  loadSettings: () => ({ hostApi: "", identityApi: "", daemonApi: "" }),
  saveSettings: vi.fn(),
});
afterAll(() => Object.assign(settingsSeams, originalSettingsSeams));
import { settingsPath } from "@opensesame/app-core/lib/crumbs.js";
import { registerOptionalTutorials } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import { SettingsSection } from "./SettingsSection.js";
import { settingsPageSources } from "./settings/page-tree.js";

let revokeTutorials: (() => void) | null = null;
beforeEach(() => {
  revokeTutorials = registerOptionalTutorials();
});
afterEach(() => {
  cleanup();
  revokeTutorials?.();
  vi.unstubAllGlobals();
});

/** A device whose only pointer is a finger, or one with a mouse attached. */
function pointer(fine: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("any-pointer: fine") ? fine : false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSection />
      <Where />
    </MemoryRouter>,
  );
}

function tabNames(): string[] {
  const nav = screen.getByRole("navigation", { name: /Settings sections/i });
  return [...nav.querySelectorAll("a")].map((link) => link.textContent ?? "");
}

describe("Settings > Keybindings on a touch-only device", () => {
  it("leaves the tab out of the strip and lands its deep link on General", async () => {
    pointer(false);
    renderAt("/settings/keybindings");
    expect(tabNames()).not.toContain("Keybindings");
    // General's own address is the bare `/settings`.
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        settingsPath("general"),
      ),
    );
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
  });

  it("leaves the rail's settings tree without the tab", () => {
    pointer(false);
    const ids = (keybindings?: boolean) =>
      settingsPageSources({ keybindings }).map((tab) => tab.id);
    expect(ids(false)).not.toContain("keybindings");
    expect(ids(true)).toContain("keybindings");
    expect(ids(undefined)).toContain("keybindings");
  });
});

describe("Settings > Keybindings with a fine pointer", () => {
  it("keeps the tab and the deep link", async () => {
    pointer(true);
    renderAt("/settings/keybindings");
    expect(tabNames()).toContain("Keybindings");
    expect(screen.getByTestId("where").textContent).toBe(
      "/settings/keybindings",
    );
  });

  it("keeps the tab where there is no matchMedia to ask", () => {
    renderAt("/settings");
    expect(tabNames()).toContain("Keybindings");
  });
});
