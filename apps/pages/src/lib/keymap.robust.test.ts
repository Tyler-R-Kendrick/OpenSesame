/** @vitest-environment jsdom */
/**
 * ADR 0150: the handler keeps working when a press is odd. A held `q` is one
 * deliberate press, a command that throws neither records nor leaves the
 * statusline stale, a macro named `constructor` is not a function to call,
 * a counted command spends the budget it uses, and a symbol made with Option
 * or AltGr is a key.
 */
import type {
  KeymapConfig,
  Macro,
} from "@opensesame/app-core/lib/keymap/config.js";
import {
  loadKeymap,
  resetKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMacro, runTarget } from "./keymap-commands.js";
import {
  NO_PENDING,
  pendingSnapshot,
  publishPending,
} from "./keymap-pending.js";
import {
  createKeymapHandler,
  keymapSeams,
  registerVaultKeymap,
} from "./keymap.js";
import { press, vault } from "./keymap.test-harness.js";

function keymap(partial: Partial<KeymapConfig>): void {
  const saved = saveKeymap({
    bindings: {},
    macros: {},
    singleKeys: true,
    ...partial,
  });
  expect(saved.ok).toBe(true);
}

function setup(overrides: Parameters<typeof vault>[0] = {}) {
  const items = vault(overrides);
  const release = registerVaultKeymap(items);
  const navigate = vi.fn();
  const handler = createKeymapHandler({ navigate, showHelp: vi.fn() });
  return { items, release, navigate, handler };
}

afterEach(() => {
  resetKeymap();
  publishPending(NO_PENDING);
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("a held key", () => {
  it("does not toggle a recording on and off, and does not finish g g", () => {
    const { items, release, handler } = setup();
    press(handler, "q");
    const held = press(handler, "q", { repeat: true });
    expect(held.defaultPrevented).toBe(true);
    expect(pendingSnapshot().awaiting).toBe("record");
    press(handler, "a");
    expect(pendingSnapshot().recording).toBe("a");

    // Held after the recording began: q stops it once, not again and again.
    press(handler, "q");
    expect(pendingSnapshot().recording).toBeNull();
    press(handler, "q", { repeat: true });
    press(handler, "q", { repeat: true });
    expect(pendingSnapshot()).toMatchObject({
      recording: null,
      awaiting: null,
    });

    press(handler, "g");
    press(handler, "g", { repeat: true });
    expect(items.first).not.toHaveBeenCalled();
    expect(pendingSnapshot().keys).toEqual(["g"]);
    release();
  });

  it("ignores a repeat of the register letter and of @", () => {
    const { release, handler } = setup();
    press(handler, "q");
    press(handler, "a");
    press(handler, "a", { repeat: true });
    expect(pendingSnapshot().recording).toBe("a");
    press(handler, "@");
    press(handler, "@", { repeat: true });
    expect(pendingSnapshot().awaiting).toBe("replay");
    release();
  });

  it("still repeats a motion held down", () => {
    const { items, release, handler } = setup();
    press(handler, "j");
    press(handler, "j", { repeat: true });
    press(handler, "j", { repeat: true });
    expect(items.next).toHaveBeenCalledTimes(3);
    release();
  });
});

describe("a command that throws", () => {
  const boom = () => {
    throw new Error("boom");
  };

  it("leaves the statusline cleared, and is not recorded", () => {
    const { items, release, handler } = setup({ next: vi.fn(boom) });
    press(handler, "q");
    press(handler, "a");
    press(handler, "3");
    expect(pendingSnapshot().count).toBe(3);
    expect(() => press(handler, "j")).toThrow("boom");
    expect(items.next).toHaveBeenCalledOnce();
    expect(pendingSnapshot().count).toBe(0);
    press(handler, "q");
    expect(loadKeymap().macros["q-a"]).toBeUndefined();
    release();
  });

  it("refreshes the statusline when the sequence timeout runs it", () => {
    vi.useFakeTimers();
    keymap({ bindings: { g: "listing.next" } });
    const { release, handler } = setup({ next: vi.fn(boom) });
    press(handler, "g");
    expect(pendingSnapshot().keys).toEqual(["g"]);
    expect(() => vi.advanceTimersByTime(keymapSeams.goTimeoutMs)).toThrow(
      "boom",
    );
    expect(pendingSnapshot().keys).toEqual([]);
    release();
  });
});

describe("a macro looked up by a name a person wrote", () => {
  const run = () => ({
    event: new KeyboardEvent("keydown"),
    steps: 1,
    hadCount: false,
    navigate: vi.fn(),
    showHelp: vi.fn(),
  });

  it("does nothing for a name that is only on Object.prototype", () => {
    const { items, release } = setup();
    for (const name of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      expect(() => runTarget(`macro.${name}`, run())).not.toThrow();
    }
    expect(items.next).not.toHaveBeenCalled();
    release();
  });

  it("does not run a macro value that holds no steps", () => {
    const { release } = setup();
    // What `macros["constructor"]` is: a value with no `steps` array.
    const broken: Macro = Object.create(null);
    expect(runMacro(broken, run())).toBe(0);
    release();
  });

  it("swallows a binding to macro.constructor from a key", () => {
    const { items, release, handler } = setup();
    const saved = saveKeymap({
      bindings: { x: "macro.constructor" },
      macros: {},
      singleKeys: true,
    });
    if (saved.ok) expect(() => press(handler, "x")).not.toThrow();
    expect(items.trash).not.toHaveBeenCalled();
    release();
  });
});

describe("the command budget", () => {
  it("charges a counted command for every repeat it makes", () => {
    keymap({
      macros: {
        dive: { steps: [{ command: "listing.dive", count: 99 }] },
      },
      bindings: { "Space d": "macro.dive" },
    });
    const { items, release, handler } = setup();
    for (const digit of "99") press(handler, digit);
    press(handler, " ");
    press(handler, "d");
    // 1,000 primitive commands however large the counts, not 99 x 99 dives.
    expect(items.enter).toHaveBeenCalledTimes(1_000);
    release();
  });

  it("clamps a counted command's count to what is left", () => {
    keymap({
      macros: {
        page: {
          steps: [
            { command: "listing.next", count: 99 },
            { command: "listing.page-down", count: 99 },
          ],
        },
      },
      bindings: { "Space p": "macro.page" },
    });
    const next = vi.fn<(count?: number) => void>();
    const page = vi.fn();
    const { release, handler } = setup({ next, page });
    for (const digit of "99") press(handler, digit);
    press(handler, " ");
    press(handler, "p");
    const stepped = next.mock.calls.reduce(
      (sum, [count]) => sum + (count ?? 1),
      0,
    );
    // Every step is charged its count, and the last one gets only what is left.
    expect(stepped + page.mock.calls.length).toBe(1_000);
    expect(stepped).toBeGreaterThan(99);
    release();
  });
});

describe("a symbol made with Option or AltGr", () => {
  it("runs a binding on it, as Option, as Windows AltGr, and as AltGraph", () => {
    keymap({ bindings: { "@": "listing.next" } });
    const { items, release, handler } = setup();
    const option = press(handler, "@", { altKey: true });
    expect(option.defaultPrevented).toBe(true);
    press(handler, "@", { ctrlKey: true, altKey: true });
    press(handler, "@", { ctrlKey: true, modifierAltGraph: true });
    expect(items.next).toHaveBeenCalledTimes(3);
    release();
  });

  it("still stands down for Alt with a letter, a digit or an arrow, and for Meta", () => {
    keymap({ bindings: { "@": "listing.next" } });
    const { items, release, handler } = setup();
    for (const key of ["j", "1", "ArrowDown"]) {
      const event = press(handler, key, { altKey: true });
      expect(event.defaultPrevented).toBe(false);
    }
    press(handler, "@", { metaKey: true });
    expect(items.next).not.toHaveBeenCalled();
    expect(items.enter).not.toHaveBeenCalled();
    release();
  });
});
