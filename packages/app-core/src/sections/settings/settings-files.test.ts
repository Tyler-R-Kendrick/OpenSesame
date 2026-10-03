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
  keybindings: {},
};

/** Settings › Keybindings: only what the person changed (ADR 0156). */
const keymap = {
  values: { singleKeys: true },
  keybindings: { w: "listing.next", x: "nop" },
  macros: {
    triage: { on: "unlock", steps: ["listing.search", "3 listing.next"] },
  },
};

it("round-trips a directory's config.yaml", () => {
  const source = encodeSettings("general", general);
  const parsed = decodeSettings("general", source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.doc).toEqual(general);
});

it("round-trips the keymap's bindings, unbinds and macros", () => {
  const source = encodeSettings("keybindings", keymap);
  expect(source).toContain("  w: listing.next");
  expect(source).toContain('    steps: [listing.search, "3 listing.next"]');
  const parsed = decodeSettings("keybindings", source);
  expect(parsed.ok && parsed.doc).toEqual(keymap);
  const nulled = decodeSettings("keybindings", "keybindings:\n  x: ~\n");
  expect(parsed.ok && nulled.ok && nulled.doc.keybindings).toEqual({
    x: "nop",
  });
});

it("refuses a keymap file the keymap itself would refuse", () => {
  expect(
    decodeSettings("keybindings", "keybindings:\n  Tab: listing.next\n").ok,
  ).toBe(false);
  expect(
    decodeSettings("keybindings", "keybindings:\n  j: item.share\n").ok,
  ).toBe(false);
  expect(
    decodeSettings(
      "keybindings",
      "macros:\n  grab:\n    on: unlock\n    steps: [item.copy-secret]\n",
    ).ok,
  ).toBe(false);
  expect(
    decodeSettings("general", "keybindings:\n  j: listing.next\n").ok,
  ).toBe(false);
});

it("refuses a value the keymap cannot read instead of dropping the line", () => {
  const refused = (source: string) => decodeSettings("keybindings", source);
  for (const value of ["5", "true", "[a]", "{ a: b }"]) {
    const result = refused(`keybindings:\n  w: ${value}\n`);
    expect(result).toEqual({
      ok: false,
      message: 'Binding for "w" is not an action id.',
    });
  }
  const context = refused("contexts:\n  vault:\n    d: 5\n");
  expect(context.ok).toBe(false);
  for (const on of ["5", "[unlock]", "true"]) {
    const result = refused(`macros:\n  top:\n    on: ${on}\n    steps: [a]\n`);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/^Macro "top": .* is not an/);
  }
  expect(refused("macros:\n  top:\n    steps: [5]\n").ok).toBe(false);
  // A null or absent value still reads as "no trigger" and "unbound".
  expect(
    refused("keybindings:\n  x: ~\nmacros:\n  t:\n    on:\n    steps: [j]\n")
      .ok,
  ).toBe(false);
  expect(
    refused(
      "keybindings:\n  x: ~\nmacros:\n  t:\n    on:\n    steps: [listing.next]\n",
    ).ok,
  ).toBe(true);
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
  const bindings = "keybindings:\n  ";
  expect(suggestSettings("keybindings", bindings, bindings.length)).toContain(
    "j",
  );
  expect(
    suggestSettings("keybindings", `${bindings}w: `, bindings.length + 3),
  ).toContain("nop");
});

describe("suggestSettings never offers back what is already typed", () => {
  const at = (source: string) =>
    suggestSettings("general", source, source.length);

  it("offers no boolean once the value is typed, and the rest while it is partial", () => {
    expect(at("lockOnHide: false")).toEqual([]);
    expect(at("lockOnHide: true")).toEqual([]);
    expect(at("lockOnHide: ")).toEqual(["true", "false"]);
    expect(at("lockOnHide: fa")).toEqual(["false"]);
    expect(at("lockOnHide: f")).toEqual(["false"]);
  });

  it("offers no enum option equal to the typed value, quoted or not", () => {
    expect(at('theme: "system"')).toEqual([]);
    expect(at("theme: dark")).toEqual([]);
    expect(at("theme: 'light'")).toEqual([]);
    expect(at("theme: s")).toEqual(["system"]);
    expect(at('theme: "s')).toEqual(["system"]);
    expect(at("theme: ")).toEqual(["system", "light", "dark"]);
  });

  it("still offers a key that is finished, so Tab can write its colon", () => {
    expect(at("theme")).toEqual(["theme"]);
    expect(at("lockOnHide")).toEqual(["lockOnHide"]);
    expect(at("th")).toEqual(["theme"]);
    expect(suggestSettings("keybindings", "keybindings", 11)).toEqual([
      "keybindings",
    ]);
    expect(at("autoLock")).toEqual(["autoLockMinutes"]);
  });

  it("offers no binding action equal to the typed one", () => {
    const atKey = (source: string) =>
      suggestSettings("keybindings", source, source.length);
    expect(atKey("keybindings:\n  j: listing.next")).toEqual([]);
    const listing = atKey("keybindings:\n  j: listing.");
    expect(listing).toContain("listing.search");
    expect(listing).toContain("listing.next");
    expect(listing).not.toContain("item.edit");
    expect(atKey("keybindings:\n  j: listing.n")).toEqual(["listing.next"]);
    expect(atKey("keybindings:\n  j: item.e")).toContain("item.edit");
    expect(atKey("keybindings:\n  j: ")).toContain("listing.next");
  });

  it("still offers a binding key that is finished, filtered by what is typed", () => {
    const atKey = (source: string) =>
      suggestSettings("keybindings", source, source.length);
    expect(atKey("keybindings:\n  s")).toEqual(["s"]);
    expect(atKey('keybindings:\n  "s"')).toEqual(["s"]);
    expect(atKey("keybindings:\n  Control")).toContain('"Control+l"');
    expect(atKey("keybindings:\n  Control+l")).toEqual(['"Control+l"']);
    expect(atKey("keybindings:\n  ")).toContain('"Control+l"');
  });

  it("offers nothing on a finished quoted binding line", () => {
    const atKey = (source: string) =>
      suggestSettings("keybindings", source, source.length);
    expect(atKey('keybindings:\n  "s": item.share')).toEqual([]);
    expect(atKey('keybindings:\n  "Control+l": command.palette')).toEqual([]);
  });
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
      "",
    ].join("\n");
    const next = { ...general, values: { ...general.values, theme: "light" } };
    const out = reconcileSource("general", saved, next);
    expect(out).toContain("# my laptop");
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

  it("drops a binding the keymap no longer has, keeping the comments", () => {
    const saved = [
      "# my keys",
      "keybindings:",
      "  w: listing.next # like j",
      "  q: help.keymap",
      "macros:",
      "  top:",
      "    steps: [listing.first] # home",
      "",
    ].join("\n");
    const next = {
      values: { singleKeys: true },
      keybindings: { w: "listing.next" },
      macros: { top: { steps: ["listing.first"] } },
    };
    const out = reconcileSource("keybindings", saved, next);
    expect(out).toContain("# like j");
    expect(out).toContain("# home");
    const parsed = decodeSettings("keybindings", out);
    expect(parsed.ok && parsed.doc.keybindings).toEqual({ w: "listing.next" });
  });

  it("rewrites macros that moved", () => {
    const before = {
      values: { singleKeys: true },
      keybindings: {},
      macros: { top: { steps: ["listing.first"] } },
    };
    const saved = encodeSettings("keybindings", before);
    const after = {
      ...before,
      macros: { top: { steps: ["listing.first", "2 listing.next"] } },
    };
    const parsed = decodeSettings(
      "keybindings",
      reconcileSource("keybindings", saved, after),
    );
    expect(parsed.ok && parsed.doc.macros).toEqual(after.macros);
  });
});
