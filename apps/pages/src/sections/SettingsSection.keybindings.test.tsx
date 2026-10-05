import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
/** @vitest-environment jsdom */
import { useEffect, useLayoutEffect } from "react";
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
import { registerOptionalTutorials } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import { stubScreen } from "../lib/use-narrow.test-support.js";
import { SettingsSection } from "./SettingsSection.js";
import { settingsPageSources } from "./settings/page-tree.js";

let revokeTutorials: (() => void) | null = null;
beforeEach(() => {
  revokeTutorials = registerOptionalTutorials();
  visited.length = 0;
  marked.length = 0;
});
afterEach(() => {
  cleanup();
  revokeTutorials?.();
  vi.unstubAllGlobals();
});

/**
 * The tab the strip marks current at the end of every commit, read in a layout
 * effect: after the DOM of that commit is written and before the passive
 * effects (the redirect) run, so the first commit is seen as it was drawn.
 */
const marked: (string | null)[] = [];
function Probe() {
  useLocation();
  useLayoutEffect(() => {
    marked.push(
      document.querySelector(
        'nav[aria-label="Settings sections"] a[aria-current]',
      )?.textContent ?? null,
    );
  });
  return null;
}

/** The address, and one entry per navigation that settled on a new one. */
const visited: string[] = [];
function Where() {
  const { pathname, key } = useLocation();
  useEffect(() => {
    visited.push(key);
  }, [key]);
  return <output data-testid="where">{pathname}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSection />
      <Where />
      <Probe />
    </MemoryRouter>,
  );
}

function tabNames(): string[] {
  const nav = screen.getByRole("navigation", { name: /Settings sections/i });
  return [...nav.querySelectorAll("a")].map((link) => link.textContent ?? "");
}

describe("Settings > Keybindings on a touch-only device", () => {
  it("keeps the tab and its deep link, and opens on the Gestures loadout", async () => {
    stubScreen({ narrow: true, coarse: true });
    renderAt("/settings/keybindings");
    expect(tabNames()).toContain("Keybindings");
    expect(screen.getByTestId("where").textContent).toBe(
      "/settings/keybindings",
    );
    // The editor is its own chunk: wait for it.
    const gestures = await screen.findByRole("tab", { name: "Gestures" });
    expect(gestures.getAttribute("aria-selected")).toBe("true");
    expect(
      await screen.findByRole("heading", { name: "Gestures" }),
    ).toBeTruthy();
    // The keys are one tab away, never gone.
    expect(screen.getByRole("tab", { name: "Keyboard" })).toBeTruthy();
  });

  it("sends the legacy #keybindings hash to its tab in one navigation", async () => {
    stubScreen({ narrow: true, coarse: true });
    renderAt("/settings#keybindings");
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        "/settings/keybindings",
      ),
    );
    expect(visited).toHaveLength(2);
  });

  it("lists the loadouts' panels in the rail's settings tree", () => {
    stubScreen({ narrow: true, coarse: true });
    const tab = settingsPageSources({}).find(
      (entry) => entry.id === "keybindings",
    );
    expect(tab?.sections?.map((section) => section.label)).toEqual([
      "Keymap",
      "Gestures",
      "Macros",
    ]);
  });
});

describe("Settings > Keybindings with a pointer and a keyboard", () => {
  it("keeps the tab and the deep link, and opens on the Keyboard loadout", async () => {
    stubScreen({ narrow: false, coarse: false });
    renderAt("/settings/keybindings");
    expect(tabNames()).toContain("Keybindings");
    expect(screen.getByTestId("where").textContent).toBe(
      "/settings/keybindings",
    );
    const keyboard = await screen.findByRole("tab", { name: "Keyboard" });
    expect(keyboard.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("heading", { name: "Keymap" })).toBeTruthy();
  });

  it("sends the legacy #keybindings hash to its tab in one navigation", async () => {
    renderAt("/settings#keybindings");
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        "/settings/keybindings",
      ),
    );
    expect(visited).toHaveLength(2);
  });

  it("keeps the tab where there is no matchMedia to ask", () => {
    renderAt("/settings");
    expect(tabNames()).toContain("Keybindings");
  });

  it("opens the Gestures loadout for a link to its panel", async () => {
    stubScreen({ narrow: false, coarse: false });
    renderAt("/settings/keybindings#settings-gestures");
    expect(
      await screen.findByRole("heading", { name: "Gestures" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Gestures" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});
