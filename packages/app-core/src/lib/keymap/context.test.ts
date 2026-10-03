import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { maybeLocalStore } from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import { memoryStorage } from "../browser-reset.fixture.js";
import { CORE_COMMANDS, NOP } from "./commands.js";
import {
  EMPTY_KEYMAP,
  type KeymapConfig,
  keymapJson,
  readKeymap,
} from "./config.js";
import {
  bindKey,
  conflictFor,
  defaultBindings,
  effectiveBindings,
  isChanged,
  keysFor,
  resetTarget,
  restoreKey,
  unbindKey,
} from "./effective.js";
import {
  KEYMAP_KEY,
  LEGACY_KEYMAP_KEY,
  reloadKeymap,
  resetKeymap,
  saveKeymap,
} from "./store.js";

const commands = CORE_COMMANDS;
const defaults = defaultBindings(commands);

function read(candidate: Parameters<typeof readKeymap>[0]) {
  return readKeymap(candidate, commands, defaults);
}

function config(candidate: Parameters<typeof readKeymap>[0]): KeymapConfig {
  const result = read(candidate);
  if (!result.ok) throw new Error(result.message);
  return result.config;
}

describe("reading context keys", () => {
  it("keeps a context's keys, sparse against the global keymap", () => {
    const result = config({
      bindings: { w: "listing.next" },
      contexts: {
        vault: { d: "item.edit", w: "listing.next", j: "listing.next" },
        rail: { x: null },
      },
    });
    // `w` and `j` already run Next row everywhere: restating them is no change.
    expect(result.contexts).toEqual({
      vault: { d: "item.edit" },
      rail: { x: NOP },
    });
  });

  it("reads a missing, empty or blank contexts as none", () => {
    expect(config({}).contexts).toBeUndefined();
    expect(config({ contexts: {} }).contexts).toBeUndefined();
    expect(config({ contexts: { vault: null } }).contexts).toBeUndefined();
  });

  it("keeps a context that only unbinds a default", () => {
    expect(config({ contexts: { rail: { q: NOP } } }).contexts).toEqual({
      rail: { q: NOP },
    });
  });

  it("refuses an unknown context, and every guardrail holds in one", () => {
    expect(read({ contexts: { detail: { d: "item.edit" } } }).ok).toBe(false);
    expect(read({ contexts: ["vault"] }).ok).toBe(false);
    expect(read({ contexts: { vault: { Tab: "item.edit" } } }).ok).toBe(false);
    expect(
      read({ contexts: { vault: { d: "https://evil.example/" } } }).ok,
    ).toBe(false);
    expect(read({ contexts: { rail: { q: "macro.missing" } } }).ok).toBe(false);
    expect(read({ contexts: { vault: { d: "not.a.command" } } }).ok).toBe(
      false,
    );
    // A command that asks before it acts gains no key in any context…
    const moved = read({ contexts: { vault: { j: "item.share" } } });
    expect(moved.ok).toBe(false);
    expect(moved.ok ? "" : moved.message).toMatch(/^In vault: /);
    // …but its own default may come back where it was struck everywhere.
    expect(
      config({ bindings: { x: NOP }, contexts: { vault: { x: "item.trash" } } })
        .contexts,
    ).toEqual({ vault: { x: "item.trash" } });
  });

  it("keeps a context key to a macro that exists", () => {
    const result = config({
      macros: { top: ["listing.first"] },
      contexts: { vault: { t: "macro.top" } },
    });
    expect(result.contexts?.vault).toEqual({ t: "macro.top" });
  });
});

describe("the keymap in force in a context", () => {
  const scoped = config({
    bindings: { w: "listing.next" },
    contexts: { vault: { d: "item.edit", j: NOP }, rail: { e: NOP } },
  });

  it("lays a context's keys over the global ones only there", () => {
    const everywhere = effectiveBindings(scoped, commands);
    const vault = effectiveBindings(scoped, commands, "vault");
    const rail = effectiveBindings(scoped, commands, "rail");
    expect(everywhere.has("d")).toBe(false);
    expect(vault.get("d")).toBe("item.edit");
    expect(rail.has("d")).toBe(false);
    expect(everywhere.get("j")).toBe("listing.next");
    expect(vault.has("j")).toBe(false);
    expect(vault.get("w")).toBe("listing.next");
    expect(rail.has("e")).toBe(false);
    expect(everywhere.get("e")).toBe("item.edit");
  });

  it("switches character keys off in a context too", () => {
    const off = { ...scoped, singleKeys: false };
    const vault = effectiveBindings(off, commands, "vault");
    expect(vault.has("d")).toBe(false);
    expect(vault.get("ArrowDown")).toBe("listing.next");
  });

  it("draws a command's keys as they hold in that context", () => {
    expect(keysFor("item.edit", scoped, commands, "vault")).toEqual([
      { sequence: "e", source: "default" },
      { sequence: "d", source: "user", scope: "vault" },
    ]);
    expect(keysFor("listing.next", scoped, commands, "vault")).toContainEqual({
      sequence: "j",
      source: "removed",
      scope: "vault",
    });
    expect(keysFor("item.edit", scoped, commands, "rail")).toEqual([
      { sequence: "e", source: "removed", scope: "rail" },
    ]);
    expect(isChanged("item.edit", scoped, commands, "vault")).toBe(true);
    // Changed everywhere is not changed in a context that left it alone.
    expect(isChanged("listing.next", scoped, commands, "rail")).toBe(false);
    expect(isChanged("listing.next", scoped, commands)).toBe(true);
  });
});

describe("changing keys in a context", () => {
  it("binds, conflicts and unbinds in that context alone", () => {
    const bound = bindKey(EMPTY_KEYMAP, commands, "d", "item.edit", {
      context: "vault",
    });
    expect(bound.bindings).toEqual({});
    expect(bound.contexts).toEqual({ vault: { d: "item.edit" } });
    const vault = effectiveBindings(bound, commands, "vault");
    expect(conflictFor("d", "item.new", vault)).toEqual({
      kind: "taken",
      target: "item.edit",
    });
    expect(
      conflictFor("d", "item.new", effectiveBindings(bound, commands)),
    ).toEqual({ kind: "none" });
    const struck = unbindKey(bound, commands, "j", "rail");
    expect(struck.contexts).toEqual({
      vault: { d: "item.edit" },
      rail: { j: NOP },
    });
    expect(unbindKey(bound, commands, "d", "vault").contexts).toEqual({});
  });

  it("swaps within a context: the holder takes the replaced key there", () => {
    const swapped = bindKey(EMPTY_KEYMAP, commands, "k", "listing.next", {
      previous: "j",
      mode: "swap",
      context: "rail",
    });
    expect(swapped.bindings).toEqual({});
    const rail = effectiveBindings(swapped, commands, "rail");
    expect(rail.get("k")).toBe("listing.next");
    expect(rail.get("j")).toBe("listing.previous");
    expect(effectiveBindings(swapped, commands).get("j")).toBe("listing.next");
  });

  it("restores and resets one context without touching the others", () => {
    let scoped = bindKey(EMPTY_KEYMAP, commands, "d", "item.edit", {
      context: "vault",
    });
    scoped = unbindKey(scoped, commands, "e", "vault");
    scoped = bindKey(scoped, commands, "d", "item.edit", { context: "rail" });
    scoped = bindKey(scoped, commands, "w", "item.edit");
    expect(restoreKey(scoped, "e", "vault").contexts?.vault).toEqual({
      d: "item.edit",
    });
    const reset = resetTarget(scoped, commands, "item.edit", "vault");
    expect(reset.contexts).toEqual({ rail: { d: "item.edit" } });
    expect(reset.bindings).toEqual({ w: "item.edit" });
  });

  it("resets a context's row whose default key went to another command there", () => {
    const scoped = bindKey(EMPTY_KEYMAP, commands, "x", "item.edit", {
      context: "vault",
    });
    expect(isChanged("item.trash", scoped, commands, "vault")).toBe(true);
    const reset = resetTarget(scoped, commands, "item.trash", "vault");
    expect(reset.contexts).toEqual({});
    expect(effectiveBindings(reset, commands, "vault").get("x")).toBe(
      "item.trash",
    );
    // The global layer is not this scope's to reset.
    const both = bindKey(scoped, commands, "x", "item.new");
    const kept = resetTarget(both, commands, "item.trash", "vault");
    expect(kept.bindings).toEqual({ x: "item.new" });
  });
});

describe("storing context keys", () => {
  afterEach(() => {
    resetKeymap();
    configureHost(createTestHost());
  });

  it("round-trips through keymapJson and the sealed store", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    const scoped = config({ contexts: { vault: { d: "item.edit" } } });
    expect(keymapJson(scoped)).toEqual({
      bindings: {},
      macros: {},
      singleKeys: true,
      contexts: { vault: { d: "item.edit" } },
    });
    expect(keymapJson(EMPTY_KEYMAP)).not.toHaveProperty("contexts");
    expect(saveKeymap(scoped).ok).toBe(true);
    expect(reloadKeymap().contexts).toEqual({ vault: { d: "item.edit" } });
  });

  it("still migrates the v1 flat map, with no contexts", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    const local = maybeLocalStore();
    local?.setItem(LEGACY_KEYMAP_KEY, JSON.stringify({ j: "item.edit" }));
    const migrated = reloadKeymap();
    expect(migrated.bindings).toEqual({ j: "item.edit" });
    expect(migrated.contexts).toBeUndefined();
    expect(JSON.parse(local?.getItem(KEYMAP_KEY) ?? "{}")).not.toHaveProperty(
      "contexts",
    );
  });
});
