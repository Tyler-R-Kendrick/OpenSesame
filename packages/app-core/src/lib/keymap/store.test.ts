import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createMemoryStorage } from "../../memory-storage.js";
import { type WebStorage, maybeLocalStore } from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import { memoryStorage } from "../browser-reset.fixture.js";
import {
  KEYMAP_KEY,
  LEGACY_KEYMAP_KEY,
  forgetKeymapForTest,
  loadKeymap,
  refreshKeymap,
  reloadKeymap,
  resetKeymap,
  saveKeymap,
  subscribeKeymap,
} from "./store.js";

/** A store that can be told to refuse a read, a write or a removal. */
function flaky() {
  const inner = createMemoryStorage();
  const refuse = { get: false, set: false, remove: false };
  const storage: WebStorage = {
    get length() {
      return inner.length;
    },
    key: (index) => inner.key(index),
    getItem(key) {
      if (refuse.get) throw new Error("blocked");
      return inner.getItem(key);
    },
    setItem(key, value) {
      if (refuse.set) throw new Error("quota");
      inner.setItem(key, value);
    },
    removeItem(key) {
      if (refuse.remove) throw new Error("blocked");
      inner.removeItem(key);
    },
  };
  configureHost(createTestHost({ storage: { local: storage } }));
  return { refuse, inner };
}

describe("the stored keymap", () => {
  afterEach(() => {
    resetKeymap();
    configureHost(createTestHost());
  });

  it("migrates the old flat map to only what the person changed", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    const local = maybeLocalStore();
    local?.setItem(
      LEGACY_KEYMAP_KEY,
      JSON.stringify({
        j: "item.edit",
        k: "listing.previous",
        "Shift+?": "help.keymap",
      }),
    );
    const config = reloadKeymap();
    expect(config.bindings).toEqual({ j: "item.edit" });
    expect(local?.getItem(LEGACY_KEYMAP_KEY)).toBeNull();
    expect(local?.getItem(KEYMAP_KEY)).not.toBeNull();
  });

  it("tells its listeners and survives a reload", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    let heard = 0;
    const stop = subscribeKeymap(() => {
      heard += 1;
    });
    const saved = saveKeymap({
      bindings: { w: "item.edit" },
      macros: { top: { steps: [{ command: "listing.first", count: 1 }] } },
      singleKeys: true,
    });
    expect(saved.ok).toBe(true);
    expect(heard).toBe(1);
    expect(reloadKeymap().macros.top?.steps).toHaveLength(1);
    expect(loadKeymap().bindings).toEqual({ w: "item.edit" });
    stop();
  });

  it("refuses a keymap whole and keeps the live one", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    saveKeymap({ bindings: { w: "item.edit" }, macros: {}, singleKeys: true });
    const refused = saveKeymap({
      bindings: { Tab: "item.edit" },
      macros: {},
      singleKeys: true,
    });
    expect(refused.ok).toBe(false);
    expect(loadKeymap().bindings).toEqual({ w: "item.edit" });
  });
});

describe("taking up another tab's keymap", () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    resetKeymap();
    configureHost(createTestHost());
  });

  const store = () => {
    const held = flaky();
    let heard = 0;
    stops.push(
      subscribeKeymap(() => {
        heard += 1;
      }),
    );
    return { ...held, heard: () => heard, tab: maybeLocalStore() };
  };

  it("says nothing while storage and the live keymap agree", () => {
    const { heard, tab } = store();
    saveKeymap({ bindings: { w: "item.edit" }, macros: {}, singleKeys: true });
    const after = heard();
    expect(refreshKeymap()).toBe(false);
    // The same keys in another order are the same keymap.
    tab?.setItem(
      KEYMAP_KEY,
      JSON.stringify({
        singleKeys: true,
        macros: {},
        bindings: { w: "item.edit" },
      }),
    );
    expect(refreshKeymap()).toBe(false);
    expect(heard()).toBe(after);
  });

  it("emits once when another tab saved something else, then stays quiet", () => {
    const { heard, tab } = store();
    saveKeymap({ bindings: { w: "item.edit" }, macros: {}, singleKeys: true });
    const after = heard();
    tab?.setItem(
      KEYMAP_KEY,
      JSON.stringify({
        bindings: { q: "item.new" },
        macros: {},
        singleKeys: true,
      }),
    );
    expect(refreshKeymap()).toBe(true);
    expect(heard()).toBe(after + 1);
    expect(loadKeymap().bindings).toEqual({ q: "item.new" });
    expect(refreshKeymap()).toBe(false);
    expect(heard()).toBe(after + 1);
  });

  it("follows a reset made in another tab", () => {
    const { tab } = store();
    saveKeymap({ bindings: { w: "item.edit" }, macros: {}, singleKeys: true });
    tab?.removeItem(KEYMAP_KEY);
    expect(refreshKeymap()).toBe(true);
    expect(loadKeymap().bindings).toEqual({});
  });

  it("leaves the live keymap alone when the store will not answer", () => {
    const { refuse, heard } = store();
    saveKeymap({ bindings: { w: "item.edit" }, macros: {}, singleKeys: true });
    const after = heard();
    refuse.get = true;
    expect(refreshKeymap()).toBe(false);
    expect(heard()).toBe(after);
    expect(loadKeymap().bindings).toEqual({ w: "item.edit" });
  });

  it("does nothing where there is no store", () => {
    configureHost(createTestHost({ storage: {} }));
    expect(refreshKeymap()).toBe(false);
  });
});

describe("a store that refuses", () => {
  afterEach(() => {
    resetKeymap();
    configureHost(createTestHost());
  });

  it("refuses a save the store would not take, and changes nothing", () => {
    const { refuse } = flaky();
    saveKeymap({ bindings: { w: "item.edit" }, macros: {}, singleKeys: true });
    let heard = 0;
    const stop = subscribeKeymap(() => {
      heard += 1;
    });
    refuse.set = true;
    const refused = saveKeymap({
      bindings: { q: "item.edit" },
      macros: {},
      singleKeys: true,
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toMatch(/could not be saved/);
    expect(heard).toBe(0);
    expect(loadKeymap().bindings).toEqual({ w: "item.edit" });
    refuse.set = false;
    expect(reloadKeymap().bindings).toEqual({ w: "item.edit" });
    stop();
  });

  it("does not take a store that will not answer for an empty keymap", () => {
    const { refuse } = flaky();
    saveKeymap({ bindings: { w: "item.edit" }, macros: {}, singleKeys: true });
    forgetKeymapForTest();
    refuse.get = true;
    expect(loadKeymap().bindings).toEqual({});
    refuse.get = false;
    expect(loadKeymap().bindings).toEqual({ w: "item.edit" });
  });

  it("migrates the old map in memory when the write is refused, and tries again on a save", () => {
    const { refuse, inner } = flaky();
    const local = maybeLocalStore();
    local?.setItem(LEGACY_KEYMAP_KEY, JSON.stringify({ j: "item.edit" }));
    forgetKeymapForTest();
    refuse.set = true;
    expect(loadKeymap().bindings).toEqual({ j: "item.edit" });
    expect(inner.getItem(KEYMAP_KEY)).toBeNull();
    expect(inner.getItem(LEGACY_KEYMAP_KEY)).not.toBeNull();
    refuse.set = false;
    const saved = saveKeymap(loadKeymap());
    expect(saved.ok).toBe(true);
    expect(inner.getItem(KEYMAP_KEY)).not.toBeNull();
    expect(inner.getItem(LEGACY_KEYMAP_KEY)).toBeNull();
  });

  it("resets even when a key will not go, and stays reset on the next load", () => {
    const { refuse } = flaky();
    saveKeymap({ bindings: { w: "item.edit" }, macros: {}, singleKeys: true });
    refuse.remove = true;
    expect(resetKeymap().bindings).toEqual({});
    refuse.remove = false;
    expect(reloadKeymap().bindings).toEqual({});
  });
});
