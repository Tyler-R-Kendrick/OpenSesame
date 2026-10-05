import { describe, expect, it } from "vitest";
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

describe("gestures in the Keybindings config.yaml (ADR 0166)", () => {
  const base = {
    values: { singleKeys: true },
    keybindings: {},
    gestures: { shake: "item.new", "two-finger-tap": "nop" },
  };

  it("spells gestures as a mapping, and reads it back", () => {
    const source = encodeSettings("keybindings", base);
    expect(source).toContain(
      ["gestures:", "  shake: item.new", "  two-finger-tap: nop"].join("\n"),
    );
    const parsed = decodeSettings("keybindings", source);
    expect(parsed.ok && parsed.doc.gestures).toEqual(base.gestures);
    const flow = decodeSettings(
      "keybindings",
      "gestures: { shake: ~, two-finger-swipe-up: item.favorite }\n",
    );
    expect(flow.ok && flow.doc.gestures).toEqual({
      shake: "nop",
      "two-finger-swipe-up": "item.favorite",
    });
  });

  it("refuses what the gesture rules refuse, and outside Keybindings", () => {
    const accepted = (source: string, category = "keybindings") =>
      decodeSettings(category, source).ok;
    expect(accepted("gestures:\n  swipe-right: item.edit\n")).toBe(false);
    expect(accepted("gestures:\n  wave: item.edit\n")).toBe(false);
    expect(accepted("gestures:\n  shake: item.trash\n")).toBe(false);
    expect(accepted("gestures:\n  shake: register.record\n")).toBe(false);
    expect(accepted("gestures: [shake]\n")).toBe(false);
    expect(accepted("motion: sometimes\n")).toBe(false);
    expect(accepted("gestures:\n  shake: item.new\n", "general")).toBe(false);
    expect(accepted("gestures:\n  shake: item.new\n")).toBe(true);
    expect(accepted("motion: false\n")).toBe(true);
  });

  it("writes the motion switch only once it is off", () => {
    expect(keymapDoc(loadKeymap()).values).toEqual({ singleKeys: true });
    expect(
      keymapDoc({
        bindings: {},
        macros: {},
        singleKeys: true,
        motion: false,
      }).values,
    ).toEqual({ singleKeys: true, motion: false });
  });

  it("patches one gesture in place, keeping every comment", () => {
    const saved = [
      "# my gestures",
      "gestures:",
      "  shake: item.new # a new item",
      "  two-finger-tap: nop",
      "",
    ].join("\n");
    const out = reconcileSource("keybindings", saved, {
      values: { singleKeys: true },
      keybindings: {},
      gestures: { shake: "item.new", "two-finger-swipe-up": "item.favorite" },
    });
    expect(out).toContain("# my gestures");
    expect(out).toContain("# a new item");
    expect(out).not.toContain("two-finger-tap");
    const parsed = decodeSettings("keybindings", out);
    expect(parsed.ok && parsed.doc.gestures).toEqual({
      shake: "item.new",
      "two-finger-swipe-up": "item.favorite",
    });
  });

  it("drops gestures once none is changed", () => {
    const out = reconcileSource("keybindings", "gestures:\n  shake: nop\n", {
      values: { singleKeys: true },
      keybindings: {},
      gestures: {},
    });
    expect(out).not.toContain("gestures");
  });

  it("carries gestures and motion from the file to the stored keymap and back", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    try {
      const parsed = decodeSettings(
        "keybindings",
        "motion: false\ngestures:\n  shake: item.new\n  two-finger-tap: ~\n",
      );
      if (!parsed.ok) throw new Error(parsed.message);
      const data = keymapData(parsed.doc);
      expect(data.motion).toBe(false);
      expect(data.gestures).toEqual({
        shake: "item.new",
        "two-finger-tap": null,
      });
      expect(saveKeymapData(data).ok).toBe(true);
      expect(loadKeymap().gestures).toEqual({
        shake: "item.new",
        "two-finger-tap": "nop",
      });
      expect(loadKeymap().motion).toBe(false);
      const doc = keymapDoc(loadKeymap());
      expect(doc.gestures).toEqual({
        shake: "item.new",
        "two-finger-tap": "nop",
      });
      expect(doc.values.motion).toBe(false);
    } finally {
      resetKeymap();
      configureHost(createTestHost());
    }
  });
});
