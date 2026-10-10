/** @vitest-environment jsdom */
import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen } from "@testing-library/react";
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
  loadSettings: () => ({
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    capabilityConnectors: { encryption: { providerId: "webcrypto" } },
  }),
  saveSettings: vi.fn(),
});
afterAll(() => Object.assign(settingsSeams, originalSettingsSeams));
import { registerOptionalTutorials } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import { SettingsSection } from "./SettingsSection.js";

let revokeTutorials: (() => void) | null = null;
beforeEach(() => {
  revokeTutorials = registerOptionalTutorials();
});
afterEach(() => {
  cleanup();
  revokeTutorials?.();
});

function renderAt(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SettingsSection />
    </MemoryRouter>,
  );
}

const documentPath = (name: string) =>
  encodeURIComponent(`settings/capabilities/${name}`);
const textEditor = () => document.querySelector(".set-raw__stage");

// A page's own document is not a second, textual view of it: opening
// `config.yaml` (the rail, the command bar, an old link) or a capability
// document draws the designed page, like every other page in the app.
describe("a page's own files", () => {
  it.each([
    ["config.yaml", "/settings/capabilities?file=config.yaml"],
    [
      "installation-selection.yaml",
      `/settings/capabilities?file=${documentPath("installation-selection.yaml")}`,
    ],
    [
      "instance-policy.yaml",
      `/settings/capabilities?file=${documentPath("instance-policy.yaml")}`,
    ],
    [
      "effective-plan.yaml",
      `/settings/capabilities?file=${documentPath("effective-plan.yaml")}`,
    ],
  ])("draw the Capabilities page, not the text of %s", (_name, route) => {
    renderAt(route);
    expect(screen.getByTestId("capabilities-panel")).toBeTruthy();
    expect(textEditor()).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
  });

  it("draw the page for any category's config.yaml", () => {
    renderAt("/settings/vaults?file=config.yaml");
    expect(screen.getByRole("heading", { name: "Item types" })).toBeTruthy();
    expect(textEditor()).toBeNull();
    cleanup();
    renderAt("/settings?file=config.yaml");
    expect(screen.getByRole("heading", { name: "Locking" })).toBeTruthy();
    expect(textEditor()).toBeNull();
  });

  it("leave the file viewer to the files a provider keeps for authoring", () => {
    renderAt(
      `/settings/vaults?file=${encodeURIComponent("settings/item-types/builtin/secret.json")}`,
    );
    expect(screen.getByRole("navigation", { name: "Files" })).toBeTruthy();
    expect(textEditor()).not.toBeNull();
  });

  it("draw Capabilities without an Endpoints panel", () => {
    renderAt("/settings/capabilities");
    expect(screen.queryByRole("heading", { name: "Endpoints" })).toBeNull();
    expect(screen.queryByLabelText("Connections service")).toBeNull();
    expect(screen.queryByLabelText("Local agent")).toBeNull();
  });
});
