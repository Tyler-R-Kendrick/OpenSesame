import { describe, expect, it } from "vitest";
import { reconcileSource } from "./settings-config.js";
import {
  decodeSettings,
  encodeSettings,
  isSettingsConfigSearch,
  legacySettingsFilePath,
  settingsConfigRoute,
  settingsFilePath,
  suggestSettings,
} from "./settings-files.js";

const general = {
  values: {
    theme: "dark",
    autoLockMinutes: 15,
    clipboardClearSeconds: 12,
    lockOnHide: false,
    signOutOnLock: true,
  },
  keybindings: { j: "listing.next" },
};

it("round-trips a directory's config.yaml", () => {
  const source = encodeSettings("general", general);
  const parsed = decodeSettings("general", source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.doc).toEqual(general);
});

it("names one config.yaml per directory, and routes to it", () => {
  expect(settingsFilePath("security")).toBe("settings/security/config.yaml");
  // The file rides the query: a static host treats a missing `.yaml` path as
  // a missing file, so a reload or a shared link would never boot the app.
  expect(settingsConfigRoute("general")).toBe("/settings?file=config.yaml");
  expect(settingsConfigRoute("security")).toBe(
    "/settings/security?file=config.yaml",
  );
  // Connections folded into Capabilities: one directory, one file, which
  // starts from the text the endpoints were kept in.
  expect(settingsFilePath("capabilities")).toBe(
    "settings/capabilities/config.yaml",
  );
  expect(legacySettingsFilePath("capabilities")).toBe(
    "settings/connections.yaml",
  );
  expect(isSettingsConfigSearch("?file=config.yaml")).toBe(true);
  expect(isSettingsConfigSearch("?file=other.yaml")).toBe(false);
});

it("rejects a value outside the directory", () => {
  expect(decodeSettings("security", "theme: dark\n").ok).toBe(false);
  expect(decodeSettings("vaults", "keybindings:\n  j: x\n").ok).toBe(false);
  expect(decodeSettings("general", "theme: sepia\n").ok).toBe(false);
  expect(decodeSettings("general", "lockOnHide: 3\n").ok).toBe(false);
});

it("reports read-only state and refuses a file that rewrites it", () => {
  const current = {
    values: { unlockMethods: ["passkey"], secondSteps: [] },
    keybindings: {},
  };
  const source = encodeSettings("security", current);
  expect(source).toContain("unlockMethods: [passkey] # read-only");
  expect(decodeSettings("security", source, current).ok).toBe(true);
  const forged = decodeSettings(
    "security",
    "unlockMethods: [passkey, pin]\n",
    current,
  );
  expect(forged).toEqual({
    ok: false,
    message: "unlockMethods is read-only here; change it on its page.",
  });
});

it("writes Capabilities' endpoints beside what the plan approved", () => {
  const current = {
    values: { approved: ["ai.webllm"], hostApi: "", identityApi: "" },
    keybindings: {},
  };
  const endpoint = decodeSettings(
    "capabilities",
    'hostApi: "https://host.example"\n',
    current,
  );
  expect(endpoint.ok).toBe(true);
  expect(
    decodeSettings("capabilities", "approved: [ai.webllm, sync]\n", current).ok,
  ).toBe(false);
});

it("gives a directory with no settings a file that says so", () => {
  const source = encodeSettings("danger", { values: {}, keybindings: {} });
  expect(source).toMatch(/^# /);
  expect(decodeSettings("danger", source).ok).toBe(true);
});

it("suggests only writable keys, enum values and bindings", () => {
  expect(suggestSettings("general", "th", 2)).toEqual(["theme"]);
  expect(suggestSettings("general", "theme: d", 8)).toEqual(["dark"]);
  expect(suggestSettings("general", "lock", 4)).toEqual(["lockOnHide"]);
  expect(suggestSettings("security", "", 0)).toEqual([]);
  const keymap = "keybindings:\n  ";
  expect(suggestSettings("general", keymap, keymap.length)).toContain("j");
});

describe("reconcileSource", () => {
  it("keeps the saved spelling while it says what the page says", () => {
    const saved = `# mine\n${encodeSettings("general", general)}`;
    expect(reconcileSource("general", saved, general)).toBe(saved);
  });

  it("patches only the value the form moved, keeping every comment", () => {
    const saved = [
      "# my laptop",
      'theme: "dark" # night owl',
      "autoLockMinutes: 15",
      "clipboardClearSeconds: 12",
      "lockOnHide: false",
      "signOutOnLock: true",
      "keybindings:",
      "  j: listing.next # vim",
      "",
    ].join("\n");
    const next = { ...general, values: { ...general.values, theme: "light" } };
    const out = reconcileSource("general", saved, next);
    expect(out).toContain("# my laptop");
    expect(out).toContain("# vim");
    expect(out).toMatch(/theme: light # night owl/);
    const parsed = decodeSettings("general", out);
    expect(parsed.ok && parsed.doc).toEqual(next);
  });

  it("derives a fresh file when nothing was saved or the save is unusable", () => {
    const fresh = encodeSettings("general", general);
    expect(reconcileSource("general", undefined, general)).toBe(fresh);
    expect(reconcileSource("general", "theme: [", general)).toBe(fresh);
  });

  it("leaves a value that did not move exactly as it was written", () => {
    const current = {
      values: { unlockMethods: ["passkey"], secondSteps: ["totp"] },
      keybindings: {},
    };
    const saved = [
      "unlockMethods:",
      "  - passkey # the laptop's",
      "secondSteps: [email]",
      "",
    ].join("\n");
    const out = reconcileSource("security", saved, current);
    expect(out).toContain("  - passkey # the laptop's");
    expect(out).toContain("secondSteps: [ totp ]");
  });

  it("drops a binding the keymap no longer has", () => {
    const saved = encodeSettings("general", {
      ...general,
      keybindings: { j: "listing.next", k: "listing.previous" },
    });
    const out = reconcileSource("general", saved, general);
    const parsed = decodeSettings("general", out);
    expect(parsed.ok && parsed.doc.keybindings).toEqual({ j: "listing.next" });
  });
});
