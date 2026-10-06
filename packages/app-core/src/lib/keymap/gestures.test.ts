import type { BoundaryObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { keymapCommands } from "./commands.js";
import { EMPTY_KEYMAP, keymapJson, readKeymap } from "./config.js";
import { defaultBindings, retargetKeys } from "./effective.js";
import {
  bindGesture,
  effectiveGestures,
  gestureRows,
  resetGesture,
} from "./gesture-bindings.js";
import {
  FIXED_GESTURES,
  GESTURES,
  GESTURE_IDS,
  gestureBindingProblem,
  gestureNameProblem,
  isGestureId,
  preferredLoadout,
} from "./gestures.js";
import { keymapFingerprint, salvageKeymap } from "./salvage.js";

const commands = keymapCommands();
const read = (candidate: BoundaryObject) =>
  readKeymap(candidate, commands, defaultBindings(commands));

describe("the gesture catalogue", () => {
  it("names each gesture once", () => {
    expect(new Set(GESTURE_IDS).size).toBe(GESTURES.length);
    for (const id of GESTURE_IDS) expect(isGestureId(id)).toBe(true);
    expect(isGestureId("tap")).toBe(false);
  });

  it("ships only defaults a hand may safely make", () => {
    for (const gesture of GESTURES) {
      expect(
        gestureBindingProblem(gesture.default, commands, {}),
        gesture.id,
      ).toBeNull();
    }
  });

  it("lists the fixed gestures a person cannot lose", () => {
    expect(FIXED_GESTURES.map(([gesture]) => gesture)).toEqual([
      "Tap",
      "Hold, or swipe a row left",
      "Swipe a pane right",
      "Swipe a page with tabs",
      "Pinch",
    ]);
  });

  it("says which names are fixed and which are not gestures", () => {
    expect(gestureNameProblem("shake")).toBeNull();
    expect(gestureNameProblem("swipe-right")).toBe(
      "swipe-right is fixed: Back.",
    );
    expect(gestureNameProblem("pinch")).toMatch(/fixed/);
    expect(gestureNameProblem("wave")).toBe('"wave" is not a gesture.');
  });
});

describe("what a gesture may run", () => {
  it("refuses a command that asks before it acts, a register, a URL, a stranger", () => {
    expect(gestureBindingProblem("item.trash", commands, {})).toMatch(
      /requires confirmation/,
    );
    expect(gestureBindingProblem("item.purge", commands, {})).toMatch(
      /requires confirmation/,
    );
    expect(gestureBindingProblem("register.record", commands, {})).toMatch(
      /waits for a letter/,
    );
    expect(gestureBindingProblem("https://evil.test", commands, {})).toMatch(
      /URLs/,
    );
    expect(gestureBindingProblem("no.such", commands, {})).toMatch(/Unknown/);
    expect(gestureBindingProblem("macro.gone", commands, {})).toMatch(
      /No macro/,
    );
  });

  it("accepts a command, a section jump, a macro that exists, and nop", () => {
    const macros = { top: { steps: [{ command: "listing.first", count: 1 }] } };
    expect(gestureBindingProblem("item.favorite", commands, {})).toBeNull();
    expect(gestureBindingProblem("section.vault", commands, {})).toBeNull();
    expect(gestureBindingProblem("section.gone", commands, {})).toBeNull();
    expect(gestureBindingProblem("macro.top", commands, macros)).toBeNull();
    expect(gestureBindingProblem("nop", commands, {})).toBeNull();
  });
});

describe("reading gestures from a keymap", () => {
  it("reads a gesture bound to a command and keeps the file sparse", () => {
    const result = read({
      gestures: {
        shake: "item.favorite",
        "two-finger-tap": "command.palette",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.gestures).toEqual({ shake: "item.favorite" });
  });

  it("reads null as striking the gesture", () => {
    const result = read({ gestures: { shake: null } });
    expect(result.ok && result.config.gestures).toEqual({ shake: "nop" });
  });

  it("refuses the whole keymap for one bad gesture", () => {
    for (const gestures of [
      { "swipe-right": "item.edit" },
      { wave: "item.edit" },
      { shake: "item.trash" },
      { shake: "register.record" },
      { shake: 5 },
      { shake: "macro.gone" },
      "shake",
    ]) {
      expect(read({ gestures }).ok, JSON.stringify(gestures)).toBe(false);
    }
  });

  it("reads a gesture bound to a macro written in the same keymap", () => {
    const result = read({
      macros: { top: ["listing.first"] },
      gestures: { "two-finger-tap": "macro.top" },
    });
    expect(result.ok && result.config.gestures).toEqual({
      "two-finger-tap": "macro.top",
    });
  });

  it("reads motion as a switch, and refuses anything else", () => {
    const off = read({ motion: false });
    expect(off.ok && off.config.motion).toBe(false);
    const on = read({ motion: true });
    expect(on.ok && on.config.motion).toBeUndefined();
    expect(read({ motion: "no" }).ok).toBe(false);
  });

  it("writes only what a person changed", () => {
    expect(keymapJson(EMPTY_KEYMAP)).not.toHaveProperty("gestures");
    expect(keymapJson(EMPTY_KEYMAP)).not.toHaveProperty("motion");
    const changed = {
      ...EMPTY_KEYMAP,
      gestures: { shake: "nop" },
      motion: false,
    };
    const json = keymapJson(changed);
    expect(json.gestures).toEqual({ shake: "nop" });
    expect(json.motion).toBe(false);
    const again = read(json);
    expect(again.ok && again.config).toEqual(changed);
  });
});

describe("the gestures in force", () => {
  it("starts from the defaults", () => {
    const live = effectiveGestures(EMPTY_KEYMAP);
    expect(live.get("two-finger-swipe-left")).toBe("listing.dive");
    expect(live.get("two-finger-swipe-right")).toBe("listing.climb");
    expect(live.get("two-finger-swipe-up")).toBe("listing.last");
    expect(live.get("two-finger-swipe-down")).toBe("listing.first");
    expect(live.get("two-finger-tap")).toBe("command.palette");
    expect(live.get("shake")).toBe("help.keymap");
  });

  it("lays a person's changes over them, and nop strikes", () => {
    const live = effectiveGestures({
      ...EMPTY_KEYMAP,
      gestures: { shake: "item.new", "two-finger-tap": "nop" },
    });
    expect(live.get("shake")).toBe("item.new");
    expect(live.has("two-finger-tap")).toBe(false);
  });

  it("drops a gesture whose macro is gone, and a shake while motion is off", () => {
    const live = effectiveGestures({
      ...EMPTY_KEYMAP,
      gestures: { "two-finger-tap": "macro.gone" },
      motion: false,
    });
    expect(live.has("two-finger-tap")).toBe(false);
    expect(live.has("shake")).toBe(false);
    expect(live.has("two-finger-swipe-up")).toBe(true);
  });

  it("draws a row per gesture with where its target came from", () => {
    const rows = gestureRows({
      ...EMPTY_KEYMAP,
      gestures: { shake: "item.new", "two-finger-tap": "nop" },
      motion: false,
    });
    expect(rows.map((row) => row.id)).toEqual(GESTURE_IDS);
    const shake = rows.find((row) => row.id === "shake");
    const tap = rows.find((row) => row.id === "two-finger-tap");
    const up = rows.find((row) => row.id === "two-finger-swipe-up");
    expect(shake).toMatchObject({ source: "user", changed: true, off: true });
    expect(tap).toMatchObject({ source: "removed", target: null });
    expect(up).toMatchObject({ source: "default", changed: false, off: false });
  });
});

describe("changing a gesture", () => {
  it("binds one, spelling it sparsely", () => {
    const bound = bindGesture(EMPTY_KEYMAP, "shake", "item.new");
    expect(bound.gestures).toEqual({ shake: "item.new" });
    const back = bindGesture(bound, "shake", "help.keymap");
    expect(back.gestures).toBeUndefined();
    expect(bindGesture(EMPTY_KEYMAP, "shake", null).gestures).toEqual({
      shake: "nop",
    });
  });

  it("resets one to its default", () => {
    const bound = bindGesture(EMPTY_KEYMAP, "shake", "item.new");
    expect(resetGesture(bound, "shake").gestures).toBeUndefined();
  });

  it("follows a renamed macro and lets go of a deleted one", () => {
    const config = {
      ...EMPTY_KEYMAP,
      macros: { a: { steps: [{ command: "listing.first", count: 1 }] } },
      gestures: { shake: "macro.a" },
    };
    expect(retargetKeys(config, "macro.a", "macro.b").gestures).toEqual({
      shake: "macro.b",
    });
    expect(retargetKeys(config, "macro.a", null).gestures).toBeUndefined();
  });
});

describe("what was stored", () => {
  it("keeps the gestures that still pass and drops the rest", () => {
    const kept = salvageKeymap({
      gestures: {
        shake: "item.new",
        "two-finger-tap": "retired.command",
        "swipe-right": "item.edit",
        "two-finger-swipe-up": "item.trash",
      },
      motion: false,
    });
    expect(kept.gestures).toEqual({ shake: "item.new" });
    expect(kept.motion).toBe(false);
  });

  it("fingerprints a gesture and the motion switch", () => {
    const base = keymapFingerprint(EMPTY_KEYMAP);
    expect(
      keymapFingerprint({ ...EMPTY_KEYMAP, gestures: { shake: "nop" } }),
    ).not.toBe(base);
    expect(keymapFingerprint({ ...EMPTY_KEYMAP, motion: false })).not.toBe(
      base,
    );
  });
});

describe("which half of the keymap a device leads with", () => {
  it("leads with gestures under a finger and keys otherwise", () => {
    expect(preferredLoadout(true)).toBe("gestures");
    expect(preferredLoadout(false)).toBe("keyboard");
  });
});
