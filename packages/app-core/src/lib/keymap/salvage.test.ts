import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { maybeLocalStore } from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import { memoryStorage } from "../browser-reset.fixture.js";
import { keymapFingerprint, salvageKeymap } from "./salvage.js";
import {
  KEYMAP_KEY,
  LEGACY_KEYMAP_KEY,
  forgetKeymapForTest,
  loadKeymap,
  resetKeymap,
  saveKeymap,
} from "./store.js";

describe("salvaging what was stored", () => {
  it("keeps a keymap that still passes whole", () => {
    const kept = salvageKeymap({
      bindings: { w: "item.edit" },
      macros: { top: ["listing.first"] },
      singleKeys: false,
    });
    expect(kept.bindings).toEqual({ w: "item.edit" });
    expect(Object.keys(kept.macros)).toEqual(["top"]);
    expect(kept.singleKeys).toBe(false);
  });

  it("drops only the entries that no longer pass", () => {
    const kept = salvageKeymap({
      bindings: {
        w: "item.edit",
        y: "retired.command",
        Tab: "listing.next",
        z: "macro.gone",
        q: "macro.top",
        "": "item.edit",
      },
      macros: {
        top: ["listing.first"],
        bad: ["item.trash"],
        Loud: ["listing.first"],
      },
      contexts: {
        vault: { d: "item.edit", e: "retired.command", Tab: "item.edit" },
        detail: { d: "item.edit" },
        rail: { z: "macro.bad" },
      },
      singleKeys: "sometimes",
    });
    expect(kept.bindings).toEqual({ w: "item.edit", q: "macro.top" });
    expect(Object.keys(kept.macros)).toEqual(["top"]);
    expect(kept.contexts).toEqual({ vault: { d: "item.edit" } });
    expect(kept.singleKeys).toBe(true);
  });

  it("keeps a lone bad macro step from costing the person their other macros", () => {
    const kept = salvageKeymap({
      macros: {
        a: ["listing.first"],
        b: ["listing.first", "not.a.command"],
        c: { on: "never", steps: ["listing.first"] },
        d: ["2 listing.next"],
      },
    });
    expect(Object.keys(kept.macros)).toEqual(["a", "d"]);
  });

  it("reads what is not a keymap as none", () => {
    expect(salvageKeymap(5).bindings).toEqual({});
    expect(salvageKeymap(null).macros).toEqual({});
    expect(salvageKeymap({ bindings: [1], macros: "x" }).bindings).toEqual({});
  });

  it("gives one fingerprint to the same keymap in any order", () => {
    const one = salvageKeymap({ bindings: { w: "item.edit", q: "item.new" } });
    const other = salvageKeymap({
      bindings: { q: "item.new", w: "item.edit" },
    });
    expect(keymapFingerprint(one)).toBe(keymapFingerprint(other));
    expect(keymapFingerprint(one)).not.toBe(
      keymapFingerprint(salvageKeymap({ bindings: { w: "item.edit" } })),
    );
  });
});

describe("loading a stored keymap with a retired entry", () => {
  afterEach(() => {
    resetKeymap();
    configureHost(createTestHost());
  });

  it("keeps the rest, and the next save overwrites only what was dropped", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    const local = maybeLocalStore();
    local?.setItem(
      KEYMAP_KEY,
      JSON.stringify({
        bindings: { w: "item.edit", y: "retired.command" },
        macros: { top: ["listing.first"] },
        singleKeys: true,
      }),
    );
    forgetKeymapForTest();
    const config = loadKeymap();
    expect(config.bindings).toEqual({ w: "item.edit" });
    expect(Object.keys(config.macros)).toEqual(["top"]);
    expect(saveKeymap(config).ok).toBe(true);
    expect(JSON.parse(local?.getItem(KEYMAP_KEY) ?? "{}").bindings).toEqual({
      w: "item.edit",
    });
  });

  it("salvages the old flat map too", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    const local = maybeLocalStore();
    local?.setItem(
      LEGACY_KEYMAP_KEY,
      JSON.stringify({ j: "item.edit", k: "retired.command" }),
    );
    forgetKeymapForTest();
    expect(loadKeymap().bindings).toEqual({ j: "item.edit" });
  });
});
