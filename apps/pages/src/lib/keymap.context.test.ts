/** @vitest-environment jsdom */
/**
 * ADR 0150 §6: a key a person scoped to the vault list or the rail tree holds
 * only while the keyboard is in that listing, and everywhere else the global
 * keymap answers as it always did.
 */
import type { KeymapConfig } from "@opensesame/app-core/lib/keymap/config.js";
import {
  resetKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKeymapHandler,
  keymapSeams,
  registerRailKeymap,
  registerVaultKeymap,
} from "./keymap.js";
import { press, rail, rowIn, targeted, vault } from "./keymap.test-harness.js";

function keymap(partial: Partial<KeymapConfig>): void {
  const saved = saveKeymap({
    bindings: {},
    macros: {},
    singleKeys: true,
    ...partial,
  });
  expect(saved.ok).toBe(true);
}

function setup() {
  const items = vault();
  const motion = rail();
  const releases = [registerVaultKeymap(items), registerRailKeymap(motion)];
  const handler = createKeymapHandler({
    navigate: vi.fn(),
    showHelp: vi.fn(),
  });
  return {
    items,
    motion,
    handler,
    release: () => {
      for (const release of releases) release();
    },
  };
}

afterEach(() => {
  resetKeymap();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("keys scoped to the vault list", () => {
  it("run in the vault listing and nowhere else", () => {
    keymap({ contexts: { vault: { w: "item.edit" } } });
    const { items, handler, release } = setup();
    targeted(handler, "w", rowIn("vtree__rows"));
    expect(items.edit).toHaveBeenCalledOnce();
    targeted(handler, "w", rowIn("railtree"));
    press(handler, "w");
    expect(items.edit).toHaveBeenCalledOnce();
    release();
  });

  it("override the global key for that sequence only there", () => {
    keymap({
      bindings: { w: "listing.next" },
      contexts: { vault: { w: "item.edit" } },
    });
    const { items, motion, handler, release } = setup();
    targeted(handler, "w", rowIn("vtree__rows"));
    expect(items.edit).toHaveBeenCalledOnce();
    expect(items.next).not.toHaveBeenCalled();
    targeted(handler, "w", rowIn("railtree"));
    expect(motion.next).toHaveBeenCalledWith(1);
    release();
  });

  it("let nop unbind a key in the vault list while it lives elsewhere", () => {
    keymap({ contexts: { vault: { j: "nop" } } });
    const { items, motion, handler, release } = setup();
    targeted(handler, "j", rowIn("vtree__rows"));
    expect(items.next).not.toHaveBeenCalled();
    targeted(handler, "j", rowIn("railtree"));
    expect(motion.next).toHaveBeenCalledWith(1);
    release();
  });
});

describe("keys scoped to the rail", () => {
  it("run in the rail tree only", () => {
    keymap({ contexts: { rail: { w: "listing.next" } } });
    const { items, motion, handler, release } = setup();
    targeted(handler, "w", rowIn("railtree"));
    expect(motion.next).toHaveBeenCalledWith(1);
    targeted(handler, "w", rowIn("vtree__rows"));
    expect(items.next).not.toHaveBeenCalled();
    release();
  });

  it("follow the keymap saved after the handler was made", () => {
    const { motion, handler, release } = setup();
    targeted(handler, "w", rowIn("railtree"));
    expect(motion.next).not.toHaveBeenCalled();
    keymap({ contexts: { rail: { w: "listing.next" } } });
    targeted(handler, "w", rowIn("railtree"));
    expect(motion.next).toHaveBeenCalledWith(1);
    release();
  });
});

describe("a sequence in a context", () => {
  it("waits vim's timeout inside the listing, then runs the shorter key", () => {
    vi.useFakeTimers();
    keymap({
      contexts: { vault: { e: "item.edit", "e e": "item.new" } },
    });
    const { items, handler, release } = setup();
    const row = rowIn("vtree__rows");
    targeted(handler, "e", row);
    expect(items.edit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    expect(items.edit).toHaveBeenCalledOnce();
    targeted(handler, "e", row);
    targeted(handler, "e", row);
    expect(items.create).toHaveBeenCalledOnce();
    release();
  });

  it("does not wait outside the listing, where the prefix does not exist", () => {
    keymap({
      contexts: { vault: { "w w": "item.new" } },
      bindings: { w: "item.edit" },
    });
    const { items, handler, release } = setup();
    press(handler, "w");
    expect(items.edit).toHaveBeenCalledOnce();
    release();
  });

  it("keeps a motion's meaning after a scoped prefix", () => {
    keymap({ contexts: { vault: { "w x": "item.new" } } });
    const { items, handler, release } = setup();
    const row = rowIn("vtree__rows");
    targeted(handler, "w", row);
    targeted(handler, "j", row);
    expect(items.next).toHaveBeenCalledWith(1);
    release();
  });
});
