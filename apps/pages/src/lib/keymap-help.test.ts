/** @vitest-environment jsdom */
/**
 * ADR 0156: the `?` sheet is drawn from the keys in force. A key moved onto
 * another command leaves its old row and joins the new one; a key taken away
 * is gone; nothing is appended beside a stale default.
 */
import { keymapCommands } from "@opensesame/app-core/lib/keymap/commands.js";
import {
  EMPTY_KEYMAP,
  type KeymapConfig,
} from "@opensesame/app-core/lib/keymap/config.js";
import { describe, expect, it } from "vitest";
import { KEYMAP_HELP_CORE, keymapHelpRows } from "./keymap-help.js";

const everything = { voice: true, share: true };

function sheet(config: KeymapConfig) {
  return keymapHelpRows(["v", "s"], everything, {
    config,
    commands: keymapCommands(),
  });
}

function keysOf(rows: ReturnType<typeof sheet>, action: string) {
  return rows.filter(([, label]) => label === action).map(([keys]) => keys);
}

describe("the sheet drawn from the keys in force", () => {
  it("reads as authored while nothing has been rebound", () => {
    expect(sheet(EMPTY_KEYMAP)).toEqual([
      ...KEYMAP_HELP_CORE,
      ["g v/s", "Go to a section"],
    ]);
  });

  it("moves j off Move and onto Edit, with no second row beside the old one", () => {
    const rows = sheet({ ...EMPTY_KEYMAP, bindings: { j: "item.edit" } });
    const text = rows.map(([keys, action]) => `${keys} — ${action}`);
    expect(text).not.toContain("j / k or arrows — Move");
    expect(text.join("\n")).not.toMatch(/\bj\b.*Move/);
    // Next row keeps its arrow; Edit holds j and e together.
    expect(keysOf(rows, "Next row")).toEqual(["↓"]);
    expect(keysOf(rows, "Edit")).toEqual(["j / e"]);
    expect(text.filter((line) => line.endsWith("— Edit"))).toHaveLength(1);
    // The count row follows what is bound: j is gone, the arrow and k remain.
    expect(keysOf(rows, "Repeat a motion")).toEqual(["3↓  10k"]);
  });

  it("drops a row once every key of its commands is taken away", () => {
    const rows = sheet({
      ...EMPTY_KEYMAP,
      bindings: { H: "nop", M: "nop", L: "nop" },
    });
    expect(keysOf(rows, "High, mid, low")).toEqual([]);
    expect(rows.some(([keys]) => keys === "H / M / L")).toBe(false);
  });

  it("keeps the fixed Enter when Dive or climb is rebuilt", () => {
    const rows = sheet({ ...EMPTY_KEYMAP, bindings: { l: "nop" } });
    expect(keysOf(rows, "Climb out")).toEqual(["h / ← / Bksp"]);
    expect(keysOf(rows, "Dive in")).toEqual(["→"]);
    expect(keysOf(rows, "Open or activate")).toEqual(["Enter"]);
  });

  it("still names Esc when the search key is unbound", () => {
    const rows = sheet({ ...EMPTY_KEYMAP, bindings: { "/": "nop" } });
    expect(keysOf(rows, "Leave the field, then the pane")).toEqual(["Esc"]);
    expect(rows.some(([, action]) => action === "Search this pane")).toBe(
      false,
    );
  });

  it("still names Esc and Enter with single keys switched off", () => {
    const rows = sheet({ ...EMPTY_KEYMAP, singleKeys: false });
    expect(keysOf(rows, "Leave the field, then the pane")).toEqual(["Esc"]);
    expect(keysOf(rows, "Open or activate")).toEqual(["Enter"]);
  });

  it("still names Enter when every dive and climb key is unbound", () => {
    const rows = sheet({
      ...EMPTY_KEYMAP,
      bindings: {
        l: "nop",
        h: "nop",
        ArrowRight: "nop",
        ArrowLeft: "nop",
        Backspace: "nop",
      },
    });
    expect(keysOf(rows, "Dive in")).toEqual([]);
    expect(keysOf(rows, "Climb out")).toEqual([]);
    expect(keysOf(rows, "Open or activate")).toEqual(["Enter"]);
  });

  it("follows a person's keys for a command the sheet has no row for", () => {
    const rows = sheet({
      ...EMPTY_KEYMAP,
      bindings: { w: "help.keymap", "?": "nop" },
    });
    expect(keysOf(rows, "Keyboard help (yours)")).toEqual(["w"]);
    expect(keysOf(rows, "unbound")).toEqual(["?"]);
  });

  it("says where a key of one listing holds", () => {
    const rows = sheet({
      ...EMPTY_KEYMAP,
      contexts: { vault: { w: "item.edit" } },
    });
    expect(rows.filter(([keys]) => keys === "w")).toHaveLength(1);
    expect(rows.find(([keys]) => keys === "w")?.[1]).toMatch(/yours, /);
  });

  it("stops naming a jump key that was handed to something else", () => {
    const rows = sheet({ ...EMPTY_KEYMAP, bindings: { "g s": "nop" } });
    expect(rows.find(([, action]) => action === "Go to a section")?.[0]).toBe(
      "g v",
    );
  });
});
