import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { memoryStorage } from "../../lib/browser-reset.fixture.js";
import {
  loadKeymap,
  resetKeymap,
  saveKeymapData,
} from "../../lib/keymap/store.js";
import { createTestHost } from "../../test-host.js";
import { reconcileSource } from "./settings-config.js";
import { decodeSettings, encodeSettings } from "./settings-files.js";
import { keymapData, keymapDoc } from "./settings-raw-editor-model.js";

/** Settings › Keybindings with keys that hold in one listing (ADR 0150 §6). */
const scoped = {
  values: { singleKeys: true },
  keybindings: { w: "listing.next" },
  contexts: { vault: { d: "item.edit", x: "nop" }, rail: { "g x": "nop" } },
};

describe("contexts in the Keybindings config.yaml", () => {
  it("spells contexts as a mapping of listings to keys, and reads it back", () => {
    const source = encodeSettings("keybindings", {
      ...scoped,
      contexts: { vault: { d: "item.edit", x: "nop" } },
    });
    expect(source).toContain(
      ["contexts:", "  vault:", "    d: item.edit", "    x: nop"].join("\n"),
    );
    const parsed = decodeSettings("keybindings", source);
    expect(parsed.ok && parsed.doc.contexts).toEqual({
      vault: { d: "item.edit", x: "nop" },
    });
    const flow = decodeSettings(
      "keybindings",
      "contexts: { vault: { d: item.edit }, rail: { j: ~ } }\n",
    );
    expect(flow.ok && flow.doc.contexts).toEqual({
      vault: { d: "item.edit" },
      rail: { j: "nop" },
    });
  });

  it("refuses contexts the keymap would refuse, and outside Keybindings", () => {
    const refused = (source: string, category = "keybindings") =>
      decodeSettings(category, source).ok;
    expect(refused("contexts:\n  detail:\n    d: item.edit\n")).toBe(false);
    expect(refused("contexts:\n  vault:\n    Tab: item.edit\n")).toBe(false);
    expect(refused("contexts:\n  vault:\n    j: item.share\n")).toBe(false);
    expect(refused("contexts:\n  vault: 5\n")).toBe(false);
    expect(refused("contexts: [vault]\n")).toBe(false);
    expect(refused("contexts:\n  vault:\n    d: item.edit\n", "general")).toBe(
      false,
    );
    expect(refused("contexts:\n  vault:\n")).toBe(true);
  });

  it("patches one context in place, keeping every comment", () => {
    const saved = [
      "# my keys",
      "keybindings:",
      "  w: listing.next # like j",
      "contexts:",
      "  vault: # the list",
      "    d: item.edit # edit in place",
      "    x: nop",
      "",
    ].join("\n");
    const next = {
      values: { singleKeys: true },
      keybindings: { w: "listing.next" },
      contexts: { vault: { d: "item.edit" }, rail: { e: "nop" } },
    };
    const out = reconcileSource("keybindings", saved, next);
    expect(out).toContain("# like j");
    expect(out).toContain("# the list");
    expect(out).toContain("# edit in place");
    expect(out).not.toContain("x: nop");
    const parsed = decodeSettings("keybindings", out);
    expect(parsed.ok && parsed.doc.contexts).toEqual(next.contexts);
  });

  it("drops contexts once none holds a key", () => {
    const saved = "contexts:\n  vault:\n    d: item.edit # mine\n";
    const out = reconcileSource("keybindings", saved, {
      values: { singleKeys: true },
      keybindings: {},
      contexts: {},
    });
    expect(out).not.toContain("contexts");
    expect(decodeSettings("keybindings", out).ok).toBe(true);
  });
});

describe("macros in the Keybindings config.yaml", () => {
  const saved = [
    "# my keys",
    "macros:",
    "  # triage the inbox",
    "  triage:",
    "    on: unlock # at the start",
    "    steps: [listing.next, listing.previous] # two moves",
    "  tidy:",
    "    # leave this one be",
    "    steps:",
    "      - listing.next",
    "",
  ].join("\n");
  const base = {
    values: { singleKeys: true },
    keybindings: {},
    macros: {
      triage: { on: "unlock", steps: ["listing.next", "listing.previous"] },
      tidy: { steps: ["listing.next"] },
    },
  };

  it("keeps every macro's spelling and comments when one step list moves", () => {
    const out = reconcileSource("keybindings", saved, {
      ...base,
      macros: {
        ...base.macros,
        triage: { on: "unlock", steps: ["listing.previous"] },
      },
    });
    expect(out).toContain("# triage the inbox");
    expect(out).toContain("# at the start");
    expect(out).toContain("# two moves");
    expect(out).toContain("# leave this one be");
    expect(out).toContain("    steps:\n      - listing.next");
    expect(out).toContain("steps: [ listing.previous ]");
    const parsed = decodeSettings("keybindings", out);
    expect(parsed.ok && parsed.doc.macros).toEqual({
      triage: { on: "unlock", steps: ["listing.previous"] },
      tidy: { steps: ["listing.next"] },
    });
  });

  it("rewrites only the moved field, adds and removes macros in place", () => {
    const out = reconcileSource("keybindings", saved, {
      ...base,
      macros: {
        triage: { steps: ["listing.next", "listing.previous"] },
        extra: { on: "unlock", steps: ["listing.next"] },
      },
    });
    expect(out).toContain("# triage the inbox");
    expect(out).toContain("# two moves");
    expect(out).not.toContain("on: unlock # at the start");
    expect(out).not.toContain("tidy");
    expect(out.indexOf("triage")).toBeLessThan(out.indexOf("extra"));
    const parsed = decodeSettings("keybindings", out);
    expect(parsed.ok && parsed.doc.macros).toEqual({
      triage: { steps: ["listing.next", "listing.previous"] },
      extra: { on: "unlock", steps: ["listing.next"] },
    });
  });

  it("patches a macro written as a bare list of steps", () => {
    const bare = "macros:\n  tidy: [listing.next] # short\n";
    const out = reconcileSource("keybindings", bare, {
      ...base,
      macros: { tidy: { steps: ["listing.previous"] } },
    });
    expect(out).toContain("tidy: [ listing.previous ]");
    expect(out).toContain("# short");
  });
});

describe("the raw editor's keymap round trip", () => {
  afterEach(() => {
    resetKeymap();
    configureHost(createTestHost());
  });

  it("carries contexts from the file to the stored keymap and back", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    const parsed = decodeSettings(
      "keybindings",
      encodeSettings("keybindings", scoped),
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const data = keymapData(parsed.doc);
    expect(data.contexts).toEqual({
      vault: { d: "item.edit", x: null },
      rail: { "g x": null },
    });
    // `g x` strikes nothing in the rail — there is no such key — so it goes.
    expect(saveKeymapData(data).ok).toBe(true);
    expect(loadKeymap().contexts).toEqual({
      vault: { d: "item.edit", x: "nop" },
    });
    expect(keymapDoc(loadKeymap()).contexts).toEqual({
      vault: { d: "item.edit", x: "nop" },
    });
  });
});
