import { describe, expect, it } from "vitest";
import { keymapCommands } from "../../lib/keymap/commands.js";
import { EMPTY_KEYMAP } from "../../lib/keymap/config.js";
import {
  gesturesForgotten,
  keysForgotten,
} from "../../lib/keymap/gesture-bindings.js";
import { choicesFor, isOffered, targetGroups } from "./gesture-panel-model.js";

const commands = keymapCommands();
const ids = (groups: ReturnType<typeof targetGroups>) =>
  groups.flatMap((group) => group.options.map((option) => option.id));

describe("what a gesture's row offers", () => {
  it("offers the commands a gesture may run, grouped as the keymap is", () => {
    const groups = targetGroups(EMPTY_KEYMAP, commands);
    expect(groups.map((group) => group.id)).toEqual([
      "move",
      "find",
      "item",
      "go",
    ]);
    expect(ids(groups)).toContain("item.favorite");
    expect(ids(groups)).toContain("listing.next");
  });

  it("never offers a command that asks first, or a register key", () => {
    const offered = ids(targetGroups(EMPTY_KEYMAP, commands));
    for (const locked of ["item.trash", "item.share", "item.purge"])
      expect(offered).not.toContain(locked);
    expect(offered).not.toContain("register.record");
    expect(offered).not.toContain("register.replay");
  });

  it("offers the person's macros last, by name", () => {
    const groups = targetGroups(
      {
        ...EMPTY_KEYMAP,
        macros: {
          zed: { steps: [{ command: "listing.first", count: 1 }] },
          alpha: { steps: [{ command: "listing.last", count: 1 }] },
        },
      },
      commands,
    );
    const last = groups.at(-1);
    expect(last?.label).toBe("Your macros");
    expect(last?.options).toEqual([
      { id: "macro.alpha", label: "@alpha" },
      { id: "macro.zed", label: "@zed" },
    ]);
  });

  it("draws a target the plan does not have under its own heading", () => {
    const groups = targetGroups(EMPTY_KEYMAP, commands);
    expect(isOffered("item.favorite", groups)).toBe(true);
    expect(isOffered("section.gone", groups)).toBe(false);
    expect(choicesFor("item.favorite", groups)).toBe(groups);
    expect(choicesFor(null, groups)).toBe(groups);
    const drawn = choicesFor("section.gone", groups);
    expect(drawn[0]).toEqual({
      id: "unavailable",
      label: "Not on this plan",
      options: [{ id: "section.gone", label: "section.gone" }],
    });
    expect(drawn).toHaveLength(groups.length + 1);
  });
});

describe("resetting one loadout", () => {
  const macro = { steps: [{ command: "listing.first", count: 1 }] };
  const config = {
    bindings: { w: "listing.next" },
    macros: { top: macro },
    singleKeys: false,
    gestures: { shake: "macro.top", "two-finger-tap": "item.new" },
    motion: false,
  };

  it("forgets the keys and macros, keeps the gestures that do not name a macro", () => {
    expect(keysForgotten(config)).toEqual({
      bindings: {},
      macros: {},
      singleKeys: true,
      motion: false,
      gestures: { "two-finger-tap": "item.new" },
    });
    expect(
      keysForgotten({ ...config, gestures: { shake: "macro.top" } }),
    ).toEqual({
      bindings: {},
      macros: {},
      singleKeys: true,
      motion: false,
    });
  });

  it("forgets the gestures and the motion switch, keeps the keys", () => {
    expect(gesturesForgotten(config)).toEqual({
      bindings: { w: "listing.next" },
      macros: { top: macro },
      singleKeys: false,
    });
  });
});
