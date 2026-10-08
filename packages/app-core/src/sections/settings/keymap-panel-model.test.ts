import { describe, expect, it } from "vitest";
import { CORE_COMMANDS } from "../../lib/keymap/commands.js";
import { EMPTY_KEYMAP } from "../../lib/keymap/config.js";
import { bindKey, unbindKey } from "../../lib/keymap/effective.js";
import {
  changedCount,
  keymapGroups,
  scopeContext,
  stepsFromKeys,
  unavailableBindings,
} from "./keymap-panel-model.js";

const commands = CORE_COMMANDS;

describe("the Keymap panel's rows", () => {
  it("groups every command, and finds one by words or by its keys", () => {
    const all = keymapGroups(EMPTY_KEYMAP, commands, {});
    expect(all.map((group) => group.label)).toEqual([
      "Move",
      "Find and ask",
      "Item",
      "Macros",
      "Go to",
    ]);
    const byWords = keymapGroups(EMPTY_KEYMAP, commands, { query: "trash" });
    expect(
      byWords.flatMap((group) => group.rows.map((row) => row.command.id)),
    ).toEqual(["item.trash"]);
    const byKeys = keymapGroups(EMPTY_KEYMAP, commands, { recorded: "g" });
    expect(
      byKeys.flatMap((group) => group.rows.map((row) => row.command.id)),
    ).toEqual([
      "listing.first",
      "session.join",
      "section.vault",
      "section.settings",
    ]);
  });

  it("filters to what changed and what has no key left", () => {
    const config = unbindKey(
      bindKey(EMPTY_KEYMAP, commands, "w", "item.edit"),
      commands,
      "H",
    );
    const changed = keymapGroups(config, commands, { filter: "changed" });
    expect(
      changed.flatMap((group) => group.rows.map((row) => row.command.id)),
    ).toEqual(["listing.high", "item.edit"]);
    const unbound = keymapGroups(config, commands, { filter: "unbound" });
    expect(
      unbound.flatMap((group) => group.rows.map((row) => row.command.id)),
    ).toEqual(["listing.high"]);
    expect(changedCount(config, commands)).toBe(2);
  });

  it("marks a key that shares a prefix, and locks what asks before acting", () => {
    const config = bindKey(EMPTY_KEYMAP, commands, "g", "help.keymap");
    const rows = keymapGroups(config, commands, { filter: "waits" }).flatMap(
      (group) => group.rows,
    );
    expect(rows.map((row) => row.command.id)).toContain("help.keymap");
    const trash = keymapGroups(EMPTY_KEYMAP, commands, { query: "trash" })[0]
      ?.rows[0];
    expect(trash?.locked).toBe(true);
  });
});

describe("recording a macro from keys", () => {
  it("reads counts and sequences the way the shell does", () => {
    const recording = stepsFromKeys(
      ["g", "g", "3", "j", "j", "/", "g", "s"],
      EMPTY_KEYMAP,
      commands,
    );
    expect(recording.steps).toEqual([
      { command: "listing.first", count: 1 },
      { command: "listing.next", count: 4 },
      { command: "listing.search", count: 1 },
      { command: "section.settings", count: 1 },
    ]);
    expect(recording.skipped).toEqual([]);
  });

  it("leaves out what a macro may not run, and says which keys", () => {
    const recording = stepsFromKeys(["x", "q", "e"], EMPTY_KEYMAP, commands);
    expect(recording.steps).toEqual([{ command: "item.edit", count: 1 }]);
    expect(recording.skipped).toEqual(["x", "q"]);
  });

  it("reads a stale prefix as the shell does: swallowed, a motion kept", () => {
    const read = (...tokens: string[]) =>
      stepsFromKeys(tokens, EMPTY_KEYMAP, commands);
    expect(read("g", "j")).toEqual({
      steps: [{ command: "session.join", count: 1 }],
      skipped: [],
    });
    expect(read("g", "k")).toEqual({
      steps: [{ command: "listing.previous", count: 1 }],
      skipped: ["g"],
    });
    expect(read("3", "g", "ArrowDown").steps).toEqual([
      { command: "listing.next", count: 3 },
    ]);
    // `y` is not a motion: the stale `g` takes it along.
    expect(read("g", "y")).toEqual({ steps: [], skipped: ["g y"] });
    expect(read("g", "y", "k").steps).toEqual([
      { command: "listing.previous", count: 1 },
    ]);
  });

  it("reads a count inside a prefix, and an uppercase after one, as the shell does", () => {
    const read = (...tokens: string[]) =>
      stepsFromKeys(tokens, EMPTY_KEYMAP, commands);
    // The shell takes a digit as a count before it reads the prefix.
    expect(read("g", "3", "j")).toEqual({
      steps: [{ command: "session.join", count: 3 }],
      skipped: [],
    });
    expect(read("g", "3", "k")).toEqual({
      steps: [{ command: "listing.previous", count: 3 }],
      skipped: ["g"],
    });
    expect(read("g", "1", "2", "k").steps).toEqual([
      { command: "listing.previous", count: 12 },
    ]);
    // `g G` is `g g` (first row), not a swallowed `g` then `G` (last row).
    expect(read("g", "G")).toEqual({
      steps: [{ command: "listing.first", count: 1 }],
      skipped: [],
    });
  });

  it("uses the person's own keys", () => {
    const config = bindKey(EMPTY_KEYMAP, commands, "w", "listing.next");
    expect(stepsFromKeys(["w"], config, commands).steps).toEqual([
      { command: "listing.next", count: 1 },
    ]);
  });
});

describe("the Keymap panel in one scope", () => {
  const scoped = bindKey(EMPTY_KEYMAP, commands, "w", "item.edit", {
    context: "vault",
  });

  it("names the context a scope stands for", () => {
    expect(scopeContext("everywhere")).toBeUndefined();
    expect(scopeContext("rail")).toBe("rail");
  });

  it("shows a context's keys as scoped, and leaves everywhere alone", () => {
    const keysOf = (scope: "everywhere" | "vault" | "rail") =>
      keymapGroups(scoped, commands, { scope })
        .flatMap((group) => group.rows)
        .find((row) => row.command.id === "item.edit")?.keys;
    expect(keysOf("vault")).toContainEqual(
      expect.objectContaining({
        sequence: "w",
        source: "user",
        scope: "vault",
      }),
    );
    expect(keysOf("everywhere")?.map((key) => key.sequence)).not.toContain("w");
    expect(keysOf("rail")?.map((key) => key.sequence)).not.toContain("w");
  });

  it("marks a row changed only in the scope that changed it", () => {
    const changed = (scope: "everywhere" | "vault") =>
      keymapGroups(scoped, commands, { scope, filter: "changed" }).flatMap(
        (group) => group.rows.map((row) => row.command.id),
      );
    expect(changed("vault")).toEqual(["item.edit"]);
    expect(changed("everywhere")).toEqual([]);
    expect(changedCount(scoped, commands)).toBe(1);
  });

  it("strikes a key a context unbinds, there only", () => {
    const struck = unbindKey(EMPTY_KEYMAP, commands, "j", "rail");
    const next = (scope: "everywhere" | "rail") =>
      keymapGroups(struck, commands, { scope })
        .flatMap((group) => group.rows)
        .find((row) => row.command.id === "listing.next")?.keys;
    expect(next("rail")).toContainEqual(
      expect.objectContaining({
        sequence: "j",
        source: "removed",
        scope: "rail",
      }),
    );
    expect(next("everywhere")).toContainEqual(
      expect.objectContaining({ sequence: "j", source: "default" }),
    );
  });
});

describe("bindings for commands this plan does not have", () => {
  it("lists them, global and per context, and skips nop and macros", () => {
    const config = {
      ...EMPTY_KEYMAP,
      bindings: { "g c": "section.connections", x: "nop" },
      contexts: { vault: { z: "section.access" }, rail: { q: "macro.triage" } },
      macros: {},
    };
    expect(unavailableBindings(config, commands)).toEqual([
      { sequence: "g c", target: "section.connections" },
      { sequence: "z", target: "section.access", scope: "vault" },
    ]);
  });

  it("lists nothing when every binding names a command that exists", () => {
    const config = bindKey(EMPTY_KEYMAP, commands, "w", "item.edit");
    expect(unavailableBindings(config, commands)).toEqual([]);
  });
});
