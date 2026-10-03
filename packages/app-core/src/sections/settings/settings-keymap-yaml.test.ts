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

/** Settings › Keybindings with keys that hold in one listing (ADR 0155 §6). */
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

describe("a first binding with a leading comment", () => {
  it("takes its comment with it when it is removed", () => {
    const saved =
      "keybindings:\n  # one\n  w: listing.next\n  # two\n  x: nop\n";
    const out = reconcileSource("keybindings", saved, {
      values: {},
      keybindings: { x: "nop" },
    });
    expect(out).toBe("keybindings:\n  # two\n  x: nop\n");
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

  it("keeps a block list a block list, and the comments on the steps that stay", () => {
    const block =
      "macros:\n  tidy:\n    steps:\n      # first\n      - listing.next # n\n      - listing.previous\n";
    const out = reconcileSource("keybindings", block, {
      ...base,
      macros: { tidy: { steps: ["listing.next"] } },
    });
    expect(out).toContain(
      "    steps:\n      # first\n      - listing.next # n",
    );
    expect(out).not.toContain("[");
    expect(out).not.toContain("listing.previous");
    const grown = reconcileSource("keybindings", block, {
      ...base,
      macros: {
        tidy: { steps: ["listing.previous", "listing.next", "listing.first"] },
      },
    });
    expect(grown).toContain("- listing.next # n");
    expect(grown).not.toContain("[");
    const parsed = decodeSettings("keybindings", grown);
    expect(parsed.ok && parsed.doc.macros).toEqual({
      tidy: { steps: ["listing.previous", "listing.next", "listing.first"] },
    });
  });

  describe("a first macro with a leading comment", () => {
    const two = [
      "macros:",
      "  # one",
      "  a: [listing.next]",
      "  # two",
      "  b: [listing.previous]",
      "",
    ].join("\n");
    const doc = (macros: Record<string, { steps: string[] }>) => ({
      values: {},
      keybindings: {},
      macros,
    });

    it("takes its comment with it when it is removed", () => {
      const out = reconcileSource(
        "keybindings",
        two,
        doc({ b: { steps: ["listing.previous"] } }),
      );
      expect(out).not.toContain("# one");
      expect(out).toBe("macros:\n  # two\n  b: [ listing.previous ]\n");
      const parsed = decodeSettings("keybindings", out);
      expect(parsed.ok && parsed.doc.macros).toEqual({
        b: { steps: ["listing.previous"] },
      });
    });

    it("keeps its place and comment when it is renamed", () => {
      const out = reconcileSource(
        "keybindings",
        two,
        doc({
          c: { steps: ["listing.next"] },
          b: { steps: ["listing.previous"] },
        }),
      );
      expect(out).toBe(
        [
          "macros:",
          "  # one",
          "  c: [ listing.next ]",
          "  # two",
          "  b: [ listing.previous ]",
          "",
        ].join("\n"),
      );
    });

    it("drops the comment with a sole macro that is removed for a new one", () => {
      const one = "macros:\n  # one\n  a: [listing.next]\n";
      const out = reconcileSource(
        "keybindings",
        one,
        doc({ z: { steps: ["listing.last"] } }),
      );
      expect(out).not.toContain("# one");
      const parsed = decodeSettings("keybindings", out);
      expect(parsed.ok && parsed.doc.macros).toEqual({
        z: { steps: ["listing.last"] },
      });
    });
  });

  describe("anchors and aliases", () => {
    // The config profile refuses aliases (`alias_forbidden`), so a file that
    // uses one cannot be patched: the editor shows the freshly derived file.
    // That drops the comments, deliberately — the safety net is the contract,
    // not an alias-aware patcher.
    const intended = {
      ...base,
      macros: {
        a: { steps: ["listing.previous"] },
        b: { steps: ["listing.next"] },
      },
    };
    const files = {
      "a steps list": [
        "macros:",
        "  # first",
        "  a:",
        "    steps: &s [listing.next]",
        "  b:",
        "    steps: *s",
        "",
      ].join("\n"),
      "a macro mapping": [
        "macros:",
        "  # first",
        "  a: &m { steps: [listing.next] }",
        "  b: *m",
        "",
      ].join("\n"),
    };

    for (const [name, saved] of Object.entries(files)) {
      it(`falls back to a fresh, valid file for ${name}`, () => {
        expect(decodeSettings("keybindings", saved).ok).toBe(false);
        const out = reconcileSource("keybindings", saved, intended);
        expect(out).toBe(encodeSettings("keybindings", intended));
        expect(out).not.toContain("# first");
        expect(out).not.toMatch(/[&*]/);
        const parsed = decodeSettings("keybindings", out);
        expect(parsed.ok && parsed.doc.macros).toEqual(intended.macros);
      });
    }
  });

  it("writes an added trigger first, as a fresh macro does", () => {
    const out = reconcileSource("keybindings", saved, {
      ...base,
      macros: {
        ...base.macros,
        tidy: { on: "unlock", steps: ["listing.next"] },
      },
    });
    expect(out).toContain(
      "    # leave this one be\n    on: unlock\n    steps:\n      - listing.next",
    );
    const parsed = decodeSettings("keybindings", out);
    expect(parsed.ok && parsed.doc.macros?.tidy).toEqual({
      on: "unlock",
      steps: ["listing.next"],
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
