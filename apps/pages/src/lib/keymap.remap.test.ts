/** @vitest-environment jsdom */
/**
 * ADR 0156: the shell's handler reads the keymap in force — a person's
 * remaps, unbinds, sequences, macros and the character-key switch — and the
 * fixed keys stay fixed whatever the keymap says.
 */
import {
  type KeymapConfig,
  MACRO_LIMITS,
} from "@opensesame/app-core/lib/keymap/config.js";
import {
  resetKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireKeymapEvent, sectionEvent } from "./keymap-events.js";
import {
  createKeymapHandler,
  keymapSeams,
  registerRailKeymap,
  registerVaultKeymap,
} from "./keymap.js";
import { press, rail, vault } from "./keymap.test-harness.js";

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
  const release = registerVaultKeymap(items);
  const navigate = vi.fn();
  const showHelp = vi.fn();
  const handler = createKeymapHandler({ navigate, showHelp });
  return { items, release, navigate, showHelp, handler };
}

afterEach(() => {
  resetKeymap();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("a person's keymap", () => {
  it("moves a command to a new key and takes away the one they struck", () => {
    keymap({ bindings: { w: "listing.next", j: "nop" } });
    const { items, release, handler } = setup();
    press(handler, "j");
    expect(items.next).not.toHaveBeenCalled();
    press(handler, "w");
    expect(items.next).toHaveBeenCalledWith(1);
    release();
  });

  it("runs a leader sequence they wrote, with the count typed before it", () => {
    keymap({ bindings: { "Space e": "item.edit", "Space j": "listing.next" } });
    const { items, release, handler } = setup();
    press(handler, "3");
    press(handler, " ");
    press(handler, "j");
    expect(items.next).toHaveBeenCalledWith(3);
    press(handler, " ");
    press(handler, "e");
    expect(items.edit).toHaveBeenCalledOnce();
    release();
  });

  it("waits vim's timeout for a key that both runs and starts a sequence", () => {
    vi.useFakeTimers();
    keymap({ bindings: { e: "item.edit", "e e": "item.new" } });
    const { items, release, handler } = setup();
    press(handler, "e");
    expect(items.edit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    expect(items.edit).toHaveBeenCalledOnce();
    press(handler, "e");
    press(handler, "e");
    expect(items.create).toHaveBeenCalledOnce();
    expect(items.edit).toHaveBeenCalledOnce();
    release();
  });

  it("switches every character key off, and leaves arrows and Control", () => {
    keymap({ singleKeys: false });
    const { items, release, handler } = setup();
    press(handler, "j");
    press(handler, "e");
    expect(items.next).not.toHaveBeenCalled();
    expect(items.edit).not.toHaveBeenCalled();
    press(handler, "ArrowDown");
    press(handler, "d", { ctrlKey: true });
    expect(items.next).toHaveBeenCalledOnce();
    expect(items.page).toHaveBeenCalledWith(1, "half");
    release();
  });

  it("keeps Escape, Tab, F6 and Enter fixed whatever the keymap says", () => {
    // The model refuses them at read time, whichever command they are given.
    for (const key of ["Escape", "Tab", "F6", "Enter"]) {
      const taken = saveKeymap({
        bindings: { [key]: "listing.next" },
        macros: {},
        singleKeys: true,
      });
      expect(taken.ok).toBe(false);
    }
    const { items, release, handler } = setup();
    const motion = rail();
    const releaseRail = registerRailKeymap(motion);

    press(handler, "Escape");
    expect(items.closeSearch).toHaveBeenCalled();
    expect(items.focus).toHaveBeenCalled();

    const tab = press(handler, "Tab");
    expect(tab.defaultPrevented).toBe(false);
    const back = press(handler, "Tab", { shiftKey: true });
    expect(back.defaultPrevented).toBe(false);

    const f6 = press(handler, "F6");
    expect(f6.defaultPrevented).toBe(true);
    expect(motion.focus).toHaveBeenCalledOnce();

    const enter = press(handler, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(items.activate).toHaveBeenCalledOnce();
    expect(items.next).not.toHaveBeenCalled();
    releaseRail();
    release();
  });
});

describe("macros", () => {
  it("runs its steps with their counts, and repeats for a count on its key", () => {
    keymap({
      macros: {
        hop: {
          steps: [
            { command: "listing.first", count: 1 },
            { command: "listing.next", count: 2 },
          ],
        },
      },
      bindings: { "Space h": "macro.hop" },
    });
    const { items, release, handler } = setup();
    press(handler, "2");
    press(handler, " ");
    press(handler, "h");
    expect(items.first).toHaveBeenCalledTimes(2);
    expect(items.next).toHaveBeenNthCalledWith(1, 2);
    expect(items.next).toHaveBeenCalledTimes(2);
    release();
  });

  it("caps what one press can do, however large the count in front of it", () => {
    keymap({
      macros: {
        spin: { steps: [{ command: "item.favorite", count: 99 }] },
      },
      bindings: { "Space f": "macro.spin" },
    });
    const { items, release, handler } = setup();
    for (const digit of "999") press(handler, digit);
    press(handler, " ");
    press(handler, "f");
    expect(items.favorite).toHaveBeenCalledTimes(MACRO_LIMITS.runs);
    release();
  });

  it("repeats a one-step macro as often as the shell counts, up to the run budget", () => {
    keymap({
      macros: { hop: { steps: [{ command: "item.favorite", count: 1 }] } },
      bindings: { "Space f": "macro.hop" },
    });
    const { items, release, handler } = setup();
    for (const digit of "999") press(handler, digit);
    press(handler, " ");
    press(handler, "f");
    expect(items.favorite).toHaveBeenCalledTimes(999);
    release();
  });

  it("stops a multi-step macro part-way through a round when the budget runs out", () => {
    keymap({
      macros: {
        pair: {
          steps: [
            { command: "item.favorite", count: 1 },
            { command: "listing.next", count: 1 },
          ],
        },
      },
      bindings: { "Space f": "macro.pair" },
    });
    const { items, release, handler } = setup();
    for (const digit of "999") press(handler, digit);
    press(handler, " ");
    press(handler, "f");
    expect(items.favorite).toHaveBeenCalledTimes(500);
    expect(items.next).toHaveBeenCalledTimes(500);
    release();
  });

  it("runs a trigger's navigation on its event, and stands down while typing", () => {
    keymap({
      macros: {
        land: {
          on: "enter:vault",
          steps: [{ command: "listing.last", count: 1 }],
        },
      },
    });
    const { items, release } = setup();
    expect(sectionEvent("/vault/login/abc")).toBe("enter:vault");
    expect(fireKeymapEvent("enter:vault", vi.fn())).toBe(1);
    expect(items.last).toHaveBeenCalledOnce();

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(fireKeymapEvent("enter:vault", vi.fn())).toBe(0);
    expect(items.last).toHaveBeenCalledOnce();
    release();
  });
});
